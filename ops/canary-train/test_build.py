import base64
import gzip
import hashlib
import importlib.util
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("build.py")
SPEC = importlib.util.spec_from_file_location("canary_build", MODULE_PATH)
build = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(build)


def make_npm_tarball(name: str, version: str, stamp: dict | None = None) -> tuple[bytes, str]:
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            entries = {
                "package/package.json": json.dumps({"name": name, "version": version}).encode(),
            }
            if stamp is not None:
                entries["package/dist/build-info.json"] = json.dumps(stamp).encode()
            for filename, data in entries.items():
                member = tarfile.TarInfo(filename)
                member.size = len(data)
                member.mtime = 0
                archive.addfile(member, io.BytesIO(data))
    data = output.getvalue()
    sri = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    return data, sri


class IntegrityAndProvenanceTests(unittest.TestCase):
    def test_resolves_canary_package_documents_from_registry_tag_urls(self):
        version = "2026.1018.0-canary.9"
        source = "a" * 40
        bodies = {}
        metadata = {}
        for name in build.DEFAULT_PACKAGES:
            payload, sri = make_npm_tarball(name, version, {"commit": source} if name == "@paperclipai/server" else None)
            url = "https://registry.npmjs.org/tarballs/" + name.replace("/", "-") + ".tgz"
            bodies[url] = payload
            metadata[build.npm_url(name, "canary")] = {"name": name, "version": version, "dist": {"tarball": url, "integrity": sri}}
        with patch.object(build, "http_json", side_effect=lambda url: metadata[url]) as request, patch.object(build, "http_bytes", side_effect=lambda url: bodies[url]):
            resolved, docs, commit = build.resolve_canary()
        self.assertEqual(resolved, version)
        self.assertEqual(commit, source)
        self.assertEqual(set(docs), set(build.DEFAULT_PACKAGES))
        self.assertEqual([call.args[0] for call in request.call_args_list], [
            "https://registry.npmjs.org/paperclipai/canary",
            "https://registry.npmjs.org/@paperclipai%2Fserver/canary",
        ])

    def test_npm_integrity_accepts_correct_sri_and_rejects_tampering(self):
        payload = b"canary package"
        sri = "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode()
        self.assertEqual(build.verify_npm_integrity(payload, sri), "sha512")
        with self.assertRaisesRegex(build.TrainError, "integrity"):
            build.verify_npm_integrity(payload + b" altered", sri)
        with self.assertRaises(build.TrainError):
            build.verify_npm_integrity(payload, "sha1-unsupported")

    def test_server_build_info_is_authoritative_and_githead_is_not_a_fallback(self):
        commit = "8de28c12e4c77b5fe0089ddeaf9ea18d216344c9"
        tarball, sri = make_npm_tarball("@paperclipai/server", "2026.1018.0-canary.1", {"commit": commit})
        self.assertEqual(build.parse_server_build_commit(tarball, sri, "2026.1018.0-canary.1"), commit)

        missing_stamp, missing_sri = make_npm_tarball("@paperclipai/server", "2026.1018.0-canary.1")
        with self.assertRaisesRegex(build.TrainError, "build-info"):
            build.parse_server_build_commit(missing_stamp, missing_sri, "2026.1018.0-canary.1")

    def test_cli_tarball_identity_is_checked_after_integrity(self):
        tarball, sri = make_npm_tarball("paperclipai", "2026.1018.0-canary.1")
        digest = build.verify_npm_tarball_identity(tarball, sri, "paperclipai", "2026.1018.0-canary.1")
        self.assertEqual(digest, hashlib.sha256(tarball).hexdigest())
        with self.assertRaisesRegex(build.TrainError, "identity"):
            build.verify_npm_tarball_identity(tarball, sri, "paperclipai", "2026.1018.0-canary.2")


class FailClosedPolicyTests(unittest.TestCase):
    def test_pinned_manifest_accepts_exact_contract_and_rejects_drift(self):
        manifest = {
            "schemaVersion": 1,
            "upstreamRepository": "paperclipai/paperclip",
            "packageNames": ["paperclipai", "@paperclipai/server"],
            "patches": [{"number": 14909, "head": "a" * 40, "repository": "paperclipai/paperclip"}],
        }
        self.assertIs(build.validate_manifest(manifest), manifest)
        changed_repo = json.loads(json.dumps(manifest))
        changed_repo["upstreamRepository"] = "attacker/paperclip"
        with self.assertRaisesRegex(build.TrainError, "official"):
            build.validate_manifest(changed_repo)
        changed = json.loads(json.dumps(manifest))
        changed["patches"][0]["head"] = "latest"
        with self.assertRaises(build.TrainError):
            build.validate_manifest(changed)
        integration = json.loads(json.dumps(manifest))
        integration["patches"][0]["integrationPatch"] = {
            "number": 14909, "path": "backports/pr14909.patch", "sha256": "b" * 64
        }
        self.assertIs(build.validate_manifest(integration), integration)
        integration["patches"][0]["integrationPatch"]["path"] = "../outside.patch"
        with self.assertRaisesRegex(build.TrainError, "path"):
            build.validate_manifest(integration)

    def test_patch_skip_precedence_and_conflict_behavior(self):
        self.assertEqual(build.patch_state(True, False, False), "already_in_release")
        self.assertEqual(build.patch_state(False, True, False), "already_present")
        self.assertEqual(build.patch_state(False, False, True), "apply")
        with self.assertRaisesRegex(build.TrainError, "conflicts"):
            build.patch_state(False, False, False)

    def test_three_way_patch_handles_context_drift_without_conflict(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "source"
            repo.mkdir()
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.name", "test"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
            source = repo / "file.txt"
            source.write_text("first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth\n")
            subprocess.run(["git", "add", "file.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True)
            base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
            subprocess.run(["git", "switch", "-c", "pr"], cwd=repo, check=True, capture_output=True)
            source.write_text("first\nsecond from PR\nthird\nfourth\nfifth\nsixth\nseventh\neighth\n")
            subprocess.run(["git", "commit", "-am", "PR change"], cwd=repo, check=True, capture_output=True)
            head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
            patch = subprocess.run(["git", "diff", f"{base}..{head}"], cwd=repo, check=True, capture_output=True).stdout
            subprocess.run(["git", "switch", "main"], cwd=repo, check=True, capture_output=True)
            source.write_text("first\nsecond\nthird\nfourth from canary\nfifth\nsixth\nseventh\neighth\n")
            subprocess.run(["git", "commit", "-am", "Canary context change"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "update-ref", "refs/pull/12/head", head], cwd=repo, check=True)

            result = build.apply_pinned_patch(repo, "paperclipai/paperclip", 12, head, patch, ["file.txt"], fetch_url=str(repo))
            self.assertEqual(result, "applied_three_way")
            self.assertEqual(source.read_text(), "first\nsecond from PR\nthird\nfourth from canary\nfifth\nsixth\nseventh\neighth\n")
            self.assertTrue(subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=repo).returncode == 1)

    def test_reviewed_integration_patch_is_used_only_after_three_way_conflict(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "source"
            repo.mkdir()
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.name", "test"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
            source = repo / "file.txt"
            source.write_text("old\ncontext\n")
            subprocess.run(["git", "add", "file.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True)
            base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
            subprocess.run(["git", "switch", "-c", "pr"], cwd=repo, check=True, capture_output=True)
            source.write_text("pr change\ncontext\n")
            subprocess.run(["git", "commit", "-am", "PR change"], cwd=repo, check=True, capture_output=True)
            head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
            pr_diff = subprocess.run(["git", "diff", f"{base}..{head}"], cwd=repo, check=True, capture_output=True).stdout
            subprocess.run(["git", "switch", "main"], cwd=repo, check=True, capture_output=True)
            source.write_text("canary change\ncontext\n")
            subprocess.run(["git", "commit", "-am", "Canary change"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "update-ref", "refs/pull/12/head", head], cwd=repo, check=True)

            source.write_text("reviewed backport\ncontext\n")
            integration_diff = subprocess.run(["git", "diff", "--", "file.txt"], cwd=repo, check=True, capture_output=True).stdout
            source.write_text("canary change\ncontext\n")
            result = build.apply_pinned_patch(
                repo, "paperclipai/paperclip", 12, head, pr_diff, ["file.txt"],
                (integration_diff, hashlib.sha256(integration_diff).hexdigest()), fetch_url=str(repo),
            )
            self.assertEqual(result, "applied_integration")
            self.assertEqual(source.read_text(), "reviewed backport\ncontext\n")

    def test_dependency_or_package_manifest_changes_are_rejected(self):
        for filename in ("package.json", "packages/db/package.json", "pnpm-lock.yaml", "packages/db/custom.lock"):
            with self.subTest(filename=filename), self.assertRaises(build.TrainError):
                build.validate_patch_paths([filename])
        build.validate_patch_paths(["server/src/index.ts", "ui/src/pages/IssueDetail.tsx"])

    def test_archive_path_and_scoped_package_roots_are_safe(self):
        for unsafe in ("../escape", "/absolute", "C:/escape", "node_modules\\escape", "a/../../b"):
            with self.subTest(unsafe=unsafe), self.assertRaises(build.TrainError):
                build.safe_relative_path(unsafe)
        self.assertEqual(str(build.archive_root("@paperclipai/server#skills")), "node_modules/@paperclipai/server/skills")
        self.assertEqual(str(build.archive_root("@paperclipai/server#ui-dist")), "node_modules/@paperclipai/server/ui-dist")
        self.assertEqual(str(build.archive_root("@paperclipai/db#dist")), "node_modules/@paperclipai/db/dist")

    def test_production_runtime_includes_only_transitive_public_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            manifest = [
                {"name": "paperclipai", "dir": "cli", "publishFromCi": True},
                {"name": "@paperclipai/server", "dir": "server", "publishFromCi": True},
                {"name": "@paperclipai/db", "dir": "packages/db", "publishFromCi": True},
                {"name": "@paperclipai/hermes-paperclip-adapter", "dir": "packages/adapters/hermes", "publishFromCi": True},
                {"name": "@paperclipai/plugin-cloudflare-sandbox", "dir": "packages/plugins/sandbox-providers/cloudflare", "publishFromCi": True},
            ]
            packages = {
                "cli/package.json": {"name": "paperclipai", "dependencies": {"@paperclipai/server": "workspace:*"}},
                "server/package.json": {"name": "@paperclipai/server", "dependencies": {"@paperclipai/db": "workspace:*"}},
                "packages/db/package.json": {"name": "@paperclipai/db"},
                "packages/adapters/hermes/package.json": {"name": "@paperclipai/hermes-paperclip-adapter"},
                "packages/plugins/sandbox-providers/cloudflare/package.json": {"name": "@paperclipai/plugin-cloudflare-sandbox"},
            }
            for relative, value in packages.items():
                path = workspace / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(value))
            closure = build.production_package_closure(workspace, manifest)
            self.assertEqual(closure, {"paperclipai", "@paperclipai/server", "@paperclipai/db"})
            with self.assertRaisesRegex(build.TrainError, "outside the installed production package closure"):
                build.validate_patch_runtime_paths(
                    workspace, manifest, ["packages/plugins/sandbox-providers/cloudflare/src/index.ts"]
                )


class PlanConstructionTests(unittest.TestCase):
    def test_detects_exec_file_sync_cargo_hook_but_not_build_command_assertions(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            hook = workspace / "server/src/__tests__/dot-runner.test.ts"
            assertion = workspace / "server/src/__tests__/docker-build-stamp.test.ts"
            hook.parent.mkdir(parents=True)
            hook.write_text('execFileSync("cargo", ["build", "--release", "--locked"]);')
            assertion.write_text('expect(native).toContain("cargo build --release");')
            self.assertEqual(
                build.native_runner_prerequisite_files(
                    workspace,
                    ["server/src/__tests__/dot-runner.test.ts", "server/src/__tests__/docker-build-stamp.test.ts"],
                ),
                ["server/src/__tests__/dot-runner.test.ts"],
            )

    def make_dry_run(self, duplicate_server=False, unknown_group=False):
        groups = sorted(build.EXPECTED_GENERAL_GROUPS)
        if unknown_group:
            groups.append("new-upstream-group")
        serialized = ["route/a.test.ts", "route/b.test.ts", "route/c.test.ts"]
        server = [[f"server/{index}.test.ts"] for index in range(4)]
        workspace_projects = {
            "general-workspaces-a": ["@paperclipai/ui", "paperclipai"],
            "general-workspaces-b": ["@paperclipai/shared", "@paperclipai/create-paperclip-plugin"],
            "general-workspaces-c": ["@paperclipai/db"],
        }
        if duplicate_server:
            server[1].append(server[0][0])

        def fake(_workspace, *flags):
            args = list(flags)
            if args == ["--mode", "all"]:
                return {"mode": "all", "availableGeneralGroups": groups, "selectedSerializedSuites": serialized, "generalServerSuiteCount": 4}
            mode = args[args.index("--mode") + 1]
            if mode == "general" and "--group" not in args:
                return {"selectedGeneralServerSuites": None}
            if mode == "general":
                group = args[args.index("--group") + 1]
                if group == "general-server":
                    index = int(args[args.index("--shard-index") + 1])
                    count = int(args[args.index("--shard-count") + 1])
                    for suite in [item for shard in server for item in shard]:
                        source = _workspace / suite
                        source.parent.mkdir(parents=True, exist_ok=True)
                        source.write_text('execFileSync("cargo"' if suite == "server/0.test.ts" else "ordinary suite")
                    if count == 1:
                        return {"selectedGeneralServerSuites": [item for shard in server for item in shard]}
                    return {"selectedGeneralServerSuites": server[index]}
                if group == "general-server-native-runner":
                    return {"selectedGeneralServerSuites": ["server/0.test.ts"]}
                return {"workspaceProjects": workspace_projects[group]}
            if mode == "serialized":
                index = int(args[args.index("--shard-index") + 1])
                return {"selectedSerializedSuites": serialized[index::2]}
            raise AssertionError(flags)
        return fake

    def test_plan_uses_exactly_nine_lanes_and_complete_disjoint_inventories(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            provenance = {"sourceCommit": "a" * 40, "patchCommit": "b" * 40, "patchTree": "c" * 40}
            with patch.object(build, "load_provenance", return_value=(provenance, [])), patch.object(build, "wrapper_dry_run", side_effect=self.make_dry_run()):
                plan = build.create_test_plan(Path(temp), output)
            self.assertEqual(len(plan["lanes"]), 9)
            self.assertEqual(plan["serverInventoryCount"], 4)
            self.assertEqual(plan["serializedInventoryCount"], 3)
            self.assertTrue(plan["lanes"][0]["nativeRunnerPreflight"])
            self.assertFalse(any(lane["nativeRunnerPreflight"] for lane in plan["lanes"][1:]))
            self.assertEqual([lane["id"] for lane in plan["lanes"][-2:]], ["serialized-1-of-2", "serialized-2-of-2"])
            self.assertEqual(build.load_test_plan(output / "test-plan.json", provenance), plan)

    def test_plan_fails_closed_on_unknown_group_or_overlapping_partition(self):
        for fake in (self.make_dry_run(duplicate_server=True), self.make_dry_run(unknown_group=True)):
            with self.subTest(fake=fake), tempfile.TemporaryDirectory() as temp:
                provenance = {"sourceCommit": "a" * 40, "patchCommit": "b" * 40, "patchTree": "c" * 40}
                with patch.object(build, "load_provenance", return_value=(provenance, [])), patch.object(build, "wrapper_dry_run", side_effect=fake):
                    with self.assertRaises(build.TrainError):
                        build.create_test_plan(Path(temp), Path(temp))


class ShardedTestReceiptTests(unittest.TestCase):
    def setUp(self):
        self.provenance = {"sourceCommit": "a" * 40, "patchCommit": "b" * 40, "patchTree": "c" * 40}
        self.plan = {
            "schemaVersion": 1,
            **self.provenance,
            "serverInventoryCount": 4,
            "serializedInventoryCount": 2,
            "workspaceProjects": {
                "general-workspaces-a": ["@paperclipai/ui", "paperclipai"],
                "general-workspaces-b": ["@paperclipai/shared", "@paperclipai/create-paperclip-plugin"],
                "general-workspaces-c": ["@paperclipai/db"],
            },
            "lanes": [
                {"id": f"general-server-{i + 1}-of-4", "mode": "general", "group": "general-server", "shardIndex": i, "shardCount": 4,
                 "nativeRunnerFiles": [], "nativeRunnerPreflight": False}
                for i in range(4)
            ] + [
                {"id": group, "mode": "general", "group": group, "shardIndex": 0, "shardCount": 1,
                 "nativeRunnerFiles": [], "nativeRunnerPreflight": False}
                for group in ("general-workspaces-a", "general-workspaces-b", "general-workspaces-c")
            ] + [
                {"id": f"serialized-{i + 1}-of-2", "mode": "serialized", "group": "serialized", "shardIndex": i, "shardCount": 2,
                 "nativeRunnerFiles": [], "nativeRunnerPreflight": False}
                for i in range(2)
            ],
        }

    def write_receipt_set(self, directory, mutate=None):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "test-plan.json").write_bytes(build.canonical_json(self.plan))
        digest = build.sha256(build.canonical_json(self.plan))
        for lane in self.plan["lanes"]:
            receipt = {"schemaVersion": 1, **self.provenance, "planDigest": digest, "lane": lane, "frozenInstall": True,
                       "runnerBinariesPrebuilt": lane["nativeRunnerPreflight"], "passed": True}
            if mutate:
                receipt = mutate(lane, receipt)
            (directory / f"test-{lane['id']}.json").write_bytes(build.canonical_json(receipt))

    def test_accepts_exact_complete_nine_lane_receipt_set(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.write_receipt_set(directory)
            plan, receipts = build.validate_test_receipts(directory, self.provenance)
            self.assertEqual(len(plan["lanes"]), 9)
            self.assertEqual(len(receipts), 9)
            self.assertTrue(all(item["passed"] is True for item in receipts))

    def test_runner_binaries_are_prebuilt_only_for_lanes_with_native_runner_suites(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            workspace, output = root / "source", root / "output"
            workspace.mkdir()
            output.mkdir()
            self.plan["lanes"][0]["nativeRunnerFiles"] = ["server/src/__tests__/dot-runner.test.ts"]
            self.plan["lanes"][0]["nativeRunnerPreflight"] = True
            (output / "test-plan.json").write_bytes(build.canonical_json(self.plan))
            commands = []
            def fake_git(_workspace, *args):
                return type("Result", (), {"stdout": b"prepared-head" if args == ("rev-parse", "HEAD") else b""})()
            with patch.object(build, "load_provenance", return_value=(self.provenance, [])), \
                 patch.object(build, "git", side_effect=fake_git), \
                 patch.object(build, "run_checked", side_effect=lambda command, cwd: commands.append((command, cwd))):
                receipt = build.run_test_lane(workspace, output, "general-server-1-of-4")
                build.run_test_lane(workspace, output, "general-server-2-of-4")
            cargo_commands = [command for command, _ in commands if command[0] == "cargo"]
            self.assertEqual(len(cargo_commands), 1)
            self.assertEqual(cargo_commands[0][1:], [
                "build", "--release", "--manifest-path", "runner/Cargo.toml", "--locked",
                "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd", "--bin", "fake-codex-app-server",
            ])
            first_lane_commands = [command for command, _ in commands[:3]]
            self.assertEqual(first_lane_commands, [
                ["pnpm", "install", "--frozen-lockfile"],
                ["pnpm", "run", "build:rust"],
                cargo_commands[0],
            ])
            self.assertEqual(receipt["runnerBinariesPrebuilt"], True)
            ordinary = json.loads((output / "test-general-server-2-of-4.json").read_text())
            self.assertFalse(ordinary["runnerBinariesPrebuilt"])

    def test_rejects_missing_lane(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.write_receipt_set(directory)
            (directory / "test-general-workspaces-b.json").unlink()
            with self.assertRaisesRegex(build.TrainError, "incomplete"):
                build.validate_test_receipts(directory, self.provenance)

    def test_rejects_duplicate_lane_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.write_receipt_set(directory)
            (directory / "test-duplicate.json").write_bytes((directory / "test-general-workspaces-a.json").read_bytes())
            with self.assertRaisesRegex(build.TrainError, "duplicate or misnamed"):
                build.validate_test_receipts(directory, self.provenance)

    def test_rejects_wrong_source_lane_or_failed_receipt(self):
        for field, value in (
            ("sourceCommit", "d" * 40),
            ("lane", {"id": "general-workspaces-a", "mode": "general", "group": "general-workspaces-b", "shardIndex": 0, "shardCount": 1}),
            ("passed", False),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                self.write_receipt_set(directory, lambda lane, receipt: {**receipt, field: value} if lane["id"] == "general-workspaces-a" else receipt)
                with self.assertRaisesRegex(build.TrainError, "exact lane and source"):
                    build.validate_test_receipts(directory, self.provenance)

    def test_rejects_plan_from_another_source_and_missing_plan(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.write_receipt_set(directory)
            with self.assertRaisesRegex(build.TrainError, "immutable source"):
                build.validate_test_receipts(directory, {**self.provenance, "sourceCommit": "d" * 40})
            (directory / "test-plan.json").unlink()
            with self.assertRaisesRegex(build.TrainError, "missing"):
                build.validate_test_receipts(directory, self.provenance)


class BuildReceiptGateTests(unittest.TestCase):
    def fixture(self, root):
        workspace = root / "source"
        output = root / "output"
        (workspace / "skills").mkdir(parents=True)
        output.mkdir()
        provenance = {"version": "2026.1018.0-canary.1", "sourceCommit": "a" * 40, "patchCommit": "b" * 40, "patchTree": "c" * 40}
        return workspace, output, provenance

    def test_receipt_build_skips_redundant_full_suite_and_sets_test_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace, output, provenance = self.fixture(Path(temp))
            commands = []
            with patch.object(build, "load_provenance", return_value=(provenance, [])), \
                 patch.object(build, "validate_test_receipts", return_value=({}, [{"passed": True}] * 9)), \
                 patch.object(build, "run_checked", side_effect=lambda command, _workspace: commands.append(command)), \
                 patch.object(build, "runtime_directories", return_value={}), \
                 patch.object(build, "git", return_value=type("Result", (), {"stdout": b""})()):
                result = build.build(workspace, output, Path(temp) / "receipts")
            self.assertNotIn(["pnpm", "test:run"], commands)
            self.assertTrue(result["quality"]["tests"])
            self.assertEqual(len(result["testEvidence"]), 9)

    def test_invalid_receipt_set_blocks_install_and_build(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace, output, provenance = self.fixture(Path(temp))
            commands = []
            with patch.object(build, "load_provenance", return_value=(provenance, [])), \
                 patch.object(build, "validate_test_receipts", side_effect=build.TrainError("missing lane")), \
                 patch.object(build, "run_checked", side_effect=lambda command, _workspace: commands.append(command)):
                with self.assertRaisesRegex(build.TrainError, "missing lane"):
                    build.build(workspace, output, Path(temp) / "receipts")
            self.assertEqual(commands, [])


class ArtifactTests(unittest.TestCase):
    def make_checkout(self, root: Path) -> tuple[Path, Path]:
        workspace = root / "source"
        workspace.mkdir()
        subprocess.run(["git", "init", "-b", build.PATCH_BRANCH], cwd=workspace, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "test"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=workspace, check=True)
        (workspace / ".gitignore").write_text("**/dist/\n**/ui-dist/\nserver/skills/\npackages/adapters/*/skills/\n")
        package_entries = [
            {"name": "paperclipai", "dir": "cli", "publishFromCi": True},
            {"name": "@paperclipai/server", "dir": "server", "publishFromCi": True},
            {"name": "@paperclipai/db", "dir": "packages/db", "publishFromCi": True},
            {"name": "@paperclipai/hermes-paperclip-adapter", "dir": "packages/adapters/hermes", "publishFromCi": True},
            {"name": "@paperclipai/plugin-cloudflare-sandbox", "dir": "packages/plugins/sandbox-providers/cloudflare", "publishFromCi": True},
            {"name": "@paperclipai/ui", "dir": "ui", "publishFromCi": True},
        ]
        (workspace / "scripts").mkdir()
        (workspace / "scripts/release-package-manifest.json").write_text(json.dumps(package_entries))
        package_manifests = {
            "cli/package.json": {
                "name": "paperclipai", "files": ["dist"],
                "dependencies": {"@paperclipai/server": "workspace:*", "@paperclipai/db": "workspace:*"},
            },
            "server/package.json": {
                "name": "@paperclipai/server", "files": ["dist", "ui-dist", "skills"],
                "dependencies": {"@paperclipai/db": "workspace:*", "@paperclipai/hermes-paperclip-adapter": "workspace:*"},
            },
            "packages/db/package.json": {"name": "@paperclipai/db", "files": ["dist"]},
            "packages/adapters/hermes/package.json": {
                "name": "@paperclipai/hermes-paperclip-adapter",
                "files": ["dist", "ui-parser.cjs", "gateway-ui-parser.cjs", "README.md", "LICENSE"],
            },
            "packages/plugins/sandbox-providers/cloudflare/package.json": {
                "name": "@paperclipai/plugin-cloudflare-sandbox", "files": ["dist"],
            },
        }
        for relative, package_json in package_manifests.items():
            path = workspace / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(package_json))
        output_map = {
            "cli/dist/index.js": b"cli runtime",
            "server/dist/index.js": b"server runtime",
            "server/ui-dist/index.html": b"ui runtime",
            "packages/db/dist/index.js": b"db runtime",
            "packages/db/dist/migrations/0001_test.sql": b"select 1;",
            "packages/db/dist/migrations/meta/_journal.json": b'{"version":"1"}',
            "packages/adapters/hermes/dist/index.js": b"hermes runtime",
            "packages/adapters/hermes/ui-parser.cjs": b"module.exports = {};",
            "packages/adapters/hermes/gateway-ui-parser.cjs": b"module.exports = {};",
            "packages/plugins/sandbox-providers/cloudflare/dist/index.js": b"standalone plugin runtime",
            "server/skills/base.md": b"server skill",
            "packages/adapters/claude-local/package.json": json.dumps({"name": "@paperclipai/adapter-claude-local"}).encode(),
            "packages/adapters/claude-local/skills/base.md": b"claude skill",
            "packages/adapters/codex-local/package.json": json.dumps({"name": "@paperclipai/adapter-codex-local"}).encode(),
            "packages/adapters/codex-local/skills/base.md": b"codex skill",
        }
        for relative, data in output_map.items():
            path = workspace / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        subprocess.run(["git", "add", "--all"], cwd=workspace, check=True)
        subprocess.run(["git", "commit", "-m", "upstream source"], cwd=workspace, check=True, capture_output=True)
        source_commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=workspace, check=True, capture_output=True, text=True).stdout.strip()
        source_tree = subprocess.run(["git", "rev-parse", "HEAD^{tree}"], cwd=workspace, check=True, capture_output=True, text=True).stdout.strip()
        (workspace / ".canary-train.json").write_text(json.dumps({
            "schemaVersion": 1, "version": "2026.1018.0-canary.1", "sourceCommit": source_commit, "patches": []
        }))
        subprocess.run(["git", "add", ".canary-train.json"], cwd=workspace, check=True)
        subprocess.run(["git", "commit", "-m", "canary-train: assemble test"], cwd=workspace, check=True, capture_output=True)
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=workspace, check=True, capture_output=True, text=True).stdout.strip()
        stamp = workspace / "server/dist/build-info.json"
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(json.dumps({"commit": commit}))
        output = root / "artifact"
        output.mkdir()
        (output / "provenance.json").write_text(json.dumps({
            "schemaVersion": 1, "version": "2026.1018.0-canary.1",
            "sourceCommit": source_commit, "sourceTree": source_tree, "branch": build.PATCH_BRANCH,
            "patchCommit": commit, "patchTree": "c" * 40, "patches": [],
            "npmPackages": {}, "patches": [],
        }))
        release_manifest = json.loads((workspace / "scripts/release-package-manifest.json").read_text())
        runtime_trees = {
            name: build.sha256(build.canonical_json(build.hash_tree(path)))
            for name, path in sorted(build.runtime_directories(workspace, release_manifest).items())
        }
        (output / "build.json").write_text(json.dumps({
            "version": "2026.1018.0-canary.1", "sourceCommit": source_commit, "patchCommit": commit,
            "quality": {"frozenInstall": True, "typecheck": True, "tests": True, "build": True, "standalonePackages": True, "serverUi": True},
            "runtimeTrees": runtime_trees,
        }))
        return workspace, output

    def test_package_outputs_full_runtime_roots_hashes_migrations_and_reproducible_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace, output = self.make_checkout(Path(temp))
            first = build.package(workspace, output)
            first_archive_hash = first["archiveSha256"]
            self.assertIn("node_modules/@paperclipai/server/dist/index.js", first["files"])
            self.assertIn("node_modules/@paperclipai/server/ui-dist/index.html", first["files"])
            self.assertIn("node_modules/@paperclipai/server/skills/base.md", first["files"])
            self.assertIn("node_modules/@paperclipai/db/dist/index.js", first["files"])
            self.assertIn("node_modules/@paperclipai/hermes-paperclip-adapter/ui-parser.cjs", first["files"])
            self.assertIn("node_modules/@paperclipai/hermes-paperclip-adapter/gateway-ui-parser.cjs", first["files"])
            self.assertEqual(
                first["packageMap"]["@paperclipai/hermes-paperclip-adapter#ui-parser.cjs"],
                "node_modules/@paperclipai/hermes-paperclip-adapter/ui-parser.cjs",
            )
            self.assertEqual(
                build.hash_tree(workspace / "packages/adapters/hermes/ui-parser.cjs"),
                {"": hashlib.sha256(b"module.exports = {};").hexdigest()},
            )
            self.assertNotIn("node_modules/@paperclipai/server/package.json", first["files"])
            self.assertNotIn("node_modules/@paperclipai/plugin-cloudflare-sandbox/dist/index.js", first["files"])
            migration_by_path = {item["path"]: item["sha256"] for item in first["migrations"]}
            self.assertEqual(migration_by_path["node_modules/@paperclipai/db/dist/migrations/0001_test.sql"], hashlib.sha256(b"select 1;").hexdigest())
            self.assertEqual(migration_by_path["node_modules/@paperclipai/db/dist/migrations/meta/_journal.json"], hashlib.sha256(b'{"version":"1"}').hexdigest())
            self.assertEqual(first["patchedCommit"], first["patchCommit"])
            second = build.package(workspace, output)
            self.assertEqual(second["archiveSha256"], first_archive_hash)

    def test_package_refuses_changed_outputs_after_successful_build(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace, output = self.make_checkout(Path(temp))
            (workspace / "server/dist/index.js").write_text("changed after build")
            with self.assertRaisesRegex(build.TrainError, "changed after"):
                build.package(workspace, output)


if __name__ == "__main__":
    unittest.main()
