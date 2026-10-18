import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import deploy


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def manifest():
    migration = "node_modules/@paperclipai/db/dist/migrations/0001_initial.sql"
    return {
        "schemaVersion": 1,
        "version": "2026.1018.0-canary.1",
        "sourceCommit": "1" * 40,
        "patchedCommit": "2" * 40,
        "controllerCommit": "3" * 40,
        "runId": "42",
        "runAttempt": 1,
        "workflowRef": "copystring/paperclip/.github/workflows/canary-patched.yml@refs/heads/deploy/canary-patched",
        "patches": [
            {"number": 14909, "repository": "paperclipai/paperclip", "head": "4" * 40, "state": "applied"},
            {"number": 16716, "repository": "paperclipai/paperclip", "head": "5" * 40, "state": "applied"},
        ],
        "quality": {"typecheck": True, "tests": True, "build": True},
        "packageNames": ["paperclipai", "@paperclipai/server"],
        "packageMap": {
            "paperclipai#dist": "node_modules/paperclipai/dist",
            "@paperclipai/server#dist": "node_modules/@paperclipai/server/dist",
            "@paperclipai/server#ui-parser.cjs": "node_modules/@paperclipai/server/ui-parser.cjs",
            "@paperclipai/db#dist": "node_modules/@paperclipai/db/dist",
        },
        "files": {
            "node_modules/paperclipai/dist/index.js": digest(b"cli"),
            "node_modules/@paperclipai/server/dist/index.js": digest(b"server"),
            "node_modules/@paperclipai/server/ui-parser.cjs": digest(b"parser"),
            migration: digest(b"create table"),
        },
        "migrations": [{"path": migration, "sha256": digest(b"create table")}],
        "archiveSha256": digest(b"archive"),
    }


class FakeHttp:
    def __init__(self, raw=None, json_data=None):
        self.raw = raw or {}
        self.json_data = json_data or {}

    def get(self, url, headers=None):
        if url not in self.raw:
            raise deploy.DeployError("unexpected GET")
        return self.raw[url]

    def request_json(self, url, method="GET", body=None, token=None):
        key = (method, url)
        if key not in self.json_data:
            raise deploy.DeployError("unexpected API request")
        value = self.json_data[key]
        if isinstance(value, Exception):
            raise value
        return value


def deployer(root: Path, http=None, command=None, **overrides):
    config = {
        "repository": "copystring/paperclip",
        "workflow": ".github/workflows/canary-patched.yml",
        "home": str(root),
        "apiBase": "http://localhost:3100",
        "authUserId": "operator",
        "hooks": [],
    }
    config.update(overrides)
    return deploy.Deployer(config, http=http or FakeHttp(),
                           command=command or (lambda *a, **k: SimpleNamespace(returncode=1)),
                           clock=lambda: 1000)


class ManifestTests(unittest.TestCase):
    def test_rejects_path_traversal_before_any_extraction(self):
        item = manifest()
        item["files"] = {"node_modules/@paperclipai/../../outside": digest(b"x")}
        with self.assertRaisesRegex(deploy.DeployError, "escapes"):
            deploy.verify_manifest(item, "copystring/paperclip", ".github/workflows/canary-patched.yml")

    def test_rejects_non_green_quality_result(self):
        item = manifest()
        item["quality"]["tests"] = False
        with self.assertRaisesRegex(deploy.DeployError, "green"):
            deploy.verify_manifest(item, "copystring/paperclip", ".github/workflows/canary-patched.yml")

    def test_rejects_migration_outside_database_migrations(self):
        item = manifest()
        item["migrations"][0]["path"] = "node_modules/@paperclipai/server/dist/index.js"
        with self.assertRaisesRegex(deploy.DeployError, "migration directory"):
            deploy.verify_manifest(item, "copystring/paperclip", ".github/workflows/canary-patched.yml")


class ReleaseTests(unittest.TestCase):
    def test_unfinished_workflow_is_distinguished_from_invalid_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = manifest()
            api = "https://api.github.com/repos/copystring/paperclip/actions/runs/42"
            http = FakeHttp(raw={api: json.dumps({"status": "in_progress"}).encode()})
            with self.assertRaises(deploy.ReleaseNotReady):
                deployer(Path(tmp), http=http).verify_workflow_run(item)

    def test_rejects_workflow_from_pull_request_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = manifest()
            raw_manifest = json.dumps(item).encode()
            manifest_url = "https://github.test/manifest"
            payload_url = "https://github.test/payload"
            release = {
                "tag_name": f"patched-canary-{item['version']}-{item['runId']}-{item['runAttempt']}",
                "target_commitish": item["controllerCommit"],
                "created_at": "2026-10-18T12:00:00Z",
                "prerelease": True,
                "assets": [
                    {"name": "manifest.json", "browser_download_url": manifest_url, "digest": "sha256:" + digest(raw_manifest)},
                    {"name": "payload.tar.gz", "browser_download_url": payload_url, "digest": "sha256:" + item["archiveSha256"]},
                ],
            }
            api = "https://api.github.com/repos/copystring/paperclip/"
            run = {
                "status": "completed", "conclusion": "success", "path": item["workflowRef"].split("@")[0],
                "event": "pull_request", "head_repository": {"full_name": "copystring/paperclip"},
                "head_sha": item["controllerCommit"], "run_attempt": 1, "head_branch": "deploy/canary-patched",
            }
            http = FakeHttp(
                raw={manifest_url: raw_manifest, api + "releases?per_page=100&page=1": json.dumps([release]).encode()},
            )
            # workflow run request is a raw GitHub API GET, appended here to
            # the same transport so no live GitHub calls are possible in tests.
            old_get = http.get
            def get(url, headers=None):
                if url == api + "actions/runs/42":
                    return json.dumps(run).encode()
                return old_get(url, headers)
            http.get = get
            with self.assertRaisesRegex(deploy.DeployError, "No verified green release"):
                deployer(Path(tmp), http=http).find_release()

    def test_rejects_asset_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = deployer(Path(tmp))
            with self.assertRaisesRegex(deploy.DeployError, "asset digest"):
                d._verify_asset_digest({"digest": "sha256:" + "0" * 64}, b"tampered", "manifest.json")


class CandidateTests(unittest.TestCase):
    def test_disk_guard_defers_before_npm_or_candidate_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            command_calls = []
            d = deployer(root, command=lambda *a, **k: command_calls.append(a) or SimpleNamespace(returncode=1))
            item = manifest()
            with patch.object(deploy.shutil, "disk_usage", return_value=SimpleNamespace(free=10)):
                with self.assertRaisesRegex(deploy.DeployError, "Insufficient free disk space"):
                    d.stage(item, {"payload.tar.gz": {"size": 1024}})
            self.assertEqual(command_calls, [])
            self.assertFalse(d.installs.exists())

    @unittest.skipIf(os.name == "nt", "production lock uses Linux fcntl")
    def test_shared_lock_rejects_concurrent_invocation(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = deployer(Path(tmp))
            with d.deployment_lock():
                with self.assertRaisesRegex(deploy.DeployError, "already holds"):
                    with d.deployment_lock():
                        pass
            self.assertEqual(d.c.get("lockFile", str(d.home / "autoupdate/autoupdate.lock")),
                             str(d.home / "autoupdate/autoupdate.lock"))

    def test_package_map_replaces_exact_single_file_runtime_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate"
            extracted = root / "extracted"
            relative = Path("node_modules/@paperclipai/server/ui-parser.cjs")
            old = candidate / relative
            source = extracted / relative
            old.parent.mkdir(parents=True)
            source.parent.mkdir(parents=True)
            old.write_text("old asset")
            source.write_text("verified parser")
            item = {"packageMap": {"@paperclipai/server#ui-parser.cjs": relative.as_posix()},
                    "files": {relative.as_posix(): digest(b"verified parser")}}
            deployer(root)._replace_package_roots(candidate, extracted, item)
            self.assertEqual(old.read_text(), "verified parser")

    def test_package_map_rejects_symlinked_single_file_ancestor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate"
            extracted = root / "extracted"
            outside = root / "outside"
            outside.mkdir()
            rel = Path("node_modules/@paperclipai/server/ui-parser.cjs")
            target_parent = candidate / "node_modules/@paperclipai/server"
            target_parent.mkdir(parents=True)
            (target_parent / "ui-parser.cjs").symlink_to(outside / "ui-parser.cjs")
            source = extracted / rel
            source.parent.mkdir(parents=True)
            source.write_text("parser")
            item = {"packageMap": {"@paperclipai/server#ui-parser.cjs": rel.as_posix()},
                    "files": {rel.as_posix(): digest(b"parser")}}
            with self.assertRaisesRegex(deploy.DeployError, "unsafe"):
                deployer(root)._replace_package_roots(candidate, extracted, item)

    def test_tar_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode="w:gz") as archive:
                info = tarfile.TarInfo("../outside")
                data = b"bad"
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            with self.assertRaisesRegex(deploy.DeployError, "escapes"):
                deployer(Path(tmp))._extract_payload(raw.getvalue(), Path(tmp), {"../outside": digest(b"bad")})

    def test_tar_rejects_file_digest_tampering(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode="w:gz") as archive:
                data = b"tampered"
                info = tarfile.TarInfo("node_modules/@paperclipai/server/dist/index.js")
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            with self.assertRaisesRegex(deploy.DeployError, "digest mismatch"):
                deployer(Path(tmp))._extract_payload(raw.getvalue(), Path(tmp), {
                    "node_modules/@paperclipai/server/dist/index.js": digest(b"expected")
                })

    def test_migration_diff_rejects_changed_or_removed_existing_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = root / "old"
            new = root / "new"
            rel = Path(deploy.MIGRATION_ROOT) / "0001_initial.sql"
            (old / rel).parent.mkdir(parents=True)
            (new / rel).parent.mkdir(parents=True)
            (old / rel).write_text("old migration")
            (new / rel).write_text("changed migration")
            with self.assertRaisesRegex(deploy.DeployError, "not identical"):
                deployer(root)._migration_diff(old, new)

    def test_migration_diff_rejects_additive_new_migrations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = root / "old"
            new = root / "new"
            rel = Path(deploy.MIGRATION_ROOT) / "0001_initial.sql"
            added = Path(deploy.MIGRATION_ROOT) / "0002_additive.sql"
            for base in (old, new):
                (base / rel).parent.mkdir(parents=True, exist_ok=True)
                (base / rel).write_text("same migration")
            (new / added).write_text("additive")
            with self.assertRaisesRegex(deploy.DeployError, "not identical"):
                deployer(root)._migration_diff(old, new)

    def test_changed_local_hook_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hook = root / "hook.py"
            hook.write_text("# changed")
            d = deployer(root, hooks=[{"path": str(hook), "sha256": "0" * 64, "kind": "codex-auth"}])
            with self.assertRaisesRegex(deploy.DeployError, "hook changed"):
                d._apply_local_hooks(root)

    def test_stage_failure_leaves_active_install_and_link_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            installs = root / ".paperclip/cli/installs/npm"
            old = installs / "old"
            old.mkdir(parents=True)
            cli = root / ".paperclip/cli"
            cli.mkdir(parents=True, exist_ok=True)
            current = cli / "current"
            current.symlink_to(old)
            (cli / "install.json").write_text(json.dumps({"version": "old", "payloadPath": str(old)}))
            version = "2026.1018.0-canary.1"
            http = FakeHttp(raw={
                f"https://registry.npmjs.org/paperclipai/{version}": json.dumps({"version": version}).encode(),
                f"https://registry.npmjs.org/%40paperclipai%2Fserver/{version}": json.dumps({"version": version}).encode(),
            })
            d = deployer(root, http=http, command=lambda *a, **k: SimpleNamespace(returncode=1, stderr="offline"))
            item = manifest()
            with self.assertRaisesRegex(deploy.DeployError, "npm install failed"):
                d.stage(item, {"payload.tar.gz": {"size": 1024}})
            self.assertEqual(current.resolve(), old)
            self.assertEqual(json.loads((cli / "install.json").read_text())["version"], "old")
            self.assertFalse(any(installs.glob(".staging-*")))

    def test_candidate_pruning_only_removes_marked_old_train_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            installs = root / ".paperclip/cli/installs/npm"
            installs.mkdir(parents=True)
            cli = root / ".paperclip/cli"
            cli.mkdir(parents=True, exist_ok=True)
            owned = []
            for index in range(6):
                path = installs / f"owned-{index}"
                path.mkdir()
                (path / ".canary-train-owned.json").write_text(json.dumps({
                    "schemaVersion": 1, "repository": "copystring/paperclip",
                    "tag": f"patched-canary-{index}", "patchedCommit": "1" * 40,
                }))
                (path / "runtime.js").write_text(str(index))
                import os
                os.utime(path, (index + 1, index + 1))
                owned.append(path)
            active = cli / "current"
            active.symlink_to(owned[0])
            user_dir = installs / "operator-data"
            user_dir.mkdir()
            (user_dir / "important.json").write_text("preserve")
            (cli / "install.json").write_text(json.dumps({
                "version": "old", "payloadPath": str(owned[0]),
                "previous": [{"payloadPath": str(owned[1])}],
            }))
            d = deployer(root)
            d._prune_owned_candidates(owned[5])
            self.assertTrue(owned[0].exists())
            self.assertTrue(owned[1].exists())
            self.assertTrue(owned[3].exists())
            self.assertTrue(owned[4].exists())
            self.assertTrue(owned[5].exists())
            self.assertFalse(owned[2].exists())
            self.assertTrue((user_dir / "important.json").exists())


class DrainTests(unittest.TestCase):
    def test_pending_run_blocks_before_drain(self):
        with tempfile.TemporaryDirectory() as tmp:
            api = "http://localhost:3100/api"
            http = FakeHttp(json_data={
                ("GET", api + "/instance/task-drain"): {"draining": False, "ownerId": None, "activeRuns": 0, "pendingWakes": 0},
                ("GET", api + "/companies"): [{"id": "company"}],
                ("GET", api + "/companies/company/live-runs?limit=50&minCount=0"): [{"id": "queued"}],
            })
            with self.assertRaisesRegex(deploy.DeployError, "queued or running"):
                deployer(Path(tmp), http=http).assert_no_work("opaque")

    def test_unknown_run_inventory_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            api = "http://localhost:3100/api"
            http = FakeHttp(json_data={
                ("GET", api + "/instance/task-drain"): {"draining": False, "ownerId": None, "activeRuns": 0, "pendingWakes": 0},
                ("GET", api + "/companies"): [{"id": "company"}],
                ("GET", api + "/companies/company/live-runs?limit=50&minCount=0"): {"unknown": True},
            })
            with self.assertRaisesRegex(deploy.DeployError, "incomplete"):
                deployer(Path(tmp), http=http).assert_no_work("opaque")

    def test_post_hold_uses_owner_safety_report_without_admission_gated_company_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            api = "http://localhost:3100/api"
            owner = "owner-id"
            http = FakeHttp(json_data={
                ("GET", api + "/instance/task-drain"): {
                    "draining": True, "ownerId": owner, "activeRuns": 0, "pendingWakes": 0,
                },
                ("GET", api + "/instance/task-drain?idleSleepSafety=1&ownerId=owner-id"): {
                    "draining": True, "ownerId": owner, "activeRuns": 0, "pendingWakes": 0,
                    "idleSleepSafety": {"version": 1, "backgroundWork": "none"},
                },
            })
            d = deployer(Path(tmp), http=http)
            d.assert_idle_checkpoint_disabled = lambda: None
            d.verify_owned_drain("token", owner)
            self.assertNotIn(("GET", api + "/companies"), http.json_data)

    def test_post_hold_unknown_safety_report_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            api = "http://localhost:3100/api"
            owner = "owner-id"
            http = FakeHttp(json_data={
                ("GET", api + "/instance/task-drain"): {
                    "draining": True, "ownerId": owner, "activeRuns": 0, "pendingWakes": 0,
                },
                ("GET", api + "/instance/task-drain?idleSleepSafety=1&ownerId=owner-id"): {
                    "idleSleepSafety": {"version": 1, "backgroundWork": "unknown"},
                },
            })
            d = deployer(Path(tmp), http=http)
            d.assert_idle_checkpoint_disabled = lambda: None
            with self.assertRaisesRegex(deploy.DeployError, "not definitively clear"):
                d.verify_owned_drain("token", owner)


class HealthTests(unittest.TestCase):
    def test_uses_existing_operator_identity_for_protected_version_readback(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = deployer(Path(tmp))
            d.load_token = lambda: "fixture-operator-token"
            d._read_install = lambda: {"version": "2026.1018.0-canary.10"}
            d.clock = iter(range(10)).__next__
            calls = []

            def health(path, method="GET", body=None, token=None):
                calls.append((path, token))
                # Mirrors Paperclip authenticated mode: anonymous health still
                # proves liveness and commit, but does not expose the version.
                data = {"status": "ok", "commit": "a" * 40}
                if token == "fixture-operator-token":
                    data["version"] = "2026.1018.0-canary.10"
                return data

            d.api_json = health
            self.assertTrue(d._wait_health("2026.1018.0-canary.10", "a" * 40, timeout=2))
            self.assertEqual(calls, [("/health", "fixture-operator-token")])

    def test_authenticated_health_still_requires_exact_runtime_identity(self):
        for change in ({"version": "wrong"}, {"commit": "b" * 40}, {"status": "starting"}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                d = deployer(Path(tmp))
                d.load_token = lambda: "fixture-operator-token"
                d._read_install = lambda: {"version": "2026.1018.0-canary.10"}
                d.clock = iter(range(10)).__next__
                data = {"status": "ok", "version": "2026.1018.0-canary.10", "commit": "a" * 40, **change}
                d.api_json = lambda *args, **kwargs: data
                with patch("deploy.time.sleep"):
                    self.assertFalse(d._wait_health("2026.1018.0-canary.10", "a" * 40, timeout=2))


class ActivationTests(unittest.TestCase):
    def make_install(self, root: Path):
        cli = root / ".paperclip/cli"
        installs = cli / "installs/npm"
        old = installs / "old"
        candidate = installs / "2026.1018.0-canary.2-patched-42-1"
        for payload in (old, candidate):
            server = payload / "node_modules/@paperclipai/server/dist"
            db_migrations = payload / "node_modules/@paperclipai/db/dist/migrations"
            (server / "onboarding-assets/default").mkdir(parents=True)
            (server / "onboarding-assets/ceo").mkdir(parents=True)
            (server / "onboarding-assets/default/AGENTS.md").write_text("default policy")
            (server / "onboarding-assets/ceo/AGENTS.md").write_text("ceo policy")
            (payload / "node_modules/@paperclipai/server/dist/build-info.json").write_text(
                json.dumps({"commit": "2" * 40 if payload == candidate else "1" * 40}))
            db_migrations.mkdir(parents=True)
            (db_migrations / "0001.sql").write_text("same")
        cli.mkdir(parents=True, exist_ok=True)
        current = cli / "current"
        current.symlink_to(old)
        old_install = {"version": "old-version", "payloadPath": str(old), "previous": []}
        (cli / "install.json").write_text(json.dumps(old_install))
        return cli, old, candidate, current, old_install

    def manifest(self):
        return {
            "version": "2026.1018.0-canary.2", "tag": "patched-canary-test",
            "sourceCommit": "3" * 40, "patchedCommit": "2" * 40, "controllerCommit": "4" * 40,
            "patches": [], "packageMap": {"@paperclipai/server#dist": "node_modules/@paperclipai/server/dist"},
        }

    def configured(self, root, command):
        d = deployer(root, command=command)
        d.assert_no_work = lambda token: None
        d.start_drain = lambda token: "owned"
        d.verify_owned_drain = lambda token, owner: None
        d.release_drain = lambda token, owner: None
        return d

    def test_partial_cutover_manifest_failure_restores_link_and_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli, old, candidate, current, previous = self.make_install(root)
            calls = []
            d = self.configured(root, lambda *a, **k: calls.append(a) or SimpleNamespace(returncode=0))
            original_write = d._write_install_atomic
            first = True

            def fail_once(data):
                nonlocal first
                if first:
                    first = False
                    raise OSError("simulated manifest write failure")
                original_write(data)

            d._write_install_atomic = fail_once
            with self.assertRaisesRegex(OSError, "simulated"):
                d.activate(candidate, self.manifest(), d._migration_diff(old, candidate), "token")
            self.assertEqual(current.resolve(), old.resolve())
            self.assertEqual(json.loads((cli / "install.json").read_text()), previous)
            self.assertEqual(calls, [])

    def test_restart_rejection_restores_and_restarts_previous_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli, old, candidate, current, previous = self.make_install(root)
            results = iter([1, 0])
            calls = []

            def command(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=next(results))

            d = self.configured(root, command)
            d._wait_health = lambda version, commit=None, timeout=90: version == previous["version"]
            with self.assertRaisesRegex(deploy.DeployError, "restart was rejected"):
                d.activate(candidate, self.manifest(), d._migration_diff(old, candidate), "token")
            self.assertEqual(current.resolve(), old.resolve())
            self.assertEqual(json.loads((cli / "install.json").read_text()), previous)
            self.assertEqual(len(calls), 2)

    def test_staged_candidate_retry_reuses_verified_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, old, candidate, _, _ = self.make_install(root)
            d = self.configured(root, lambda *a, **k: SimpleNamespace(returncode=1))
            item = self.manifest()
            item.update({"runId": "42", "runAttempt": 1, "archiveSha256": "a" * 64})
            # A deterministic receipt covers post-hook file bytes and all
            # protected package roots; no npm or archive rewrite is needed.
            protected = d._protected_inventory(candidate, item["packageMap"].values())
            candidate_files = {"node_modules/@paperclipai/server/dist/build-info.json": deploy.hash_file(
                candidate / "node_modules/@paperclipai/server/dist/build-info.json")}
            # stage verifies the candidate file receipt; the migration tree
            # is separately pinned by the release manifest.
            item["files"] = candidate_files
            item["migrations"] = [{"path": "node_modules/@paperclipai/db/dist/migrations/0001.sql",
                                  "sha256": deploy.hash_file(candidate / "node_modules/@paperclipai/db/dist/migrations/0001.sql")}]
            marker = {"schemaVersion": 1, "repository": "copystring/paperclip", "tag": item["tag"],
                      "version": item["version"], "runId": item["runId"], "runAttempt": item["runAttempt"],
                      "patchedCommit": item["patchedCommit"], "archiveSha256": item["archiveSha256"],
                      "candidateFiles": candidate_files, "protectedRoots": sorted(item["packageMap"].values()),
                      "protectedFiles": protected}
            (candidate / ".canary-train-owned.json").write_text(json.dumps(marker))
            d._verify_registered_support_files = lambda: None
            d._verify_local_hook_files = lambda path: None
            version = item["version"]
            d._npm_metadata = lambda requested: ["paperclipai", "@paperclipai/server"]
            path, migration_diff = d.stage(item, {"payload.tar.gz": {"size": 1024}})
            self.assertEqual(path, candidate)
            self.assertEqual(migration_diff["baselinePath"], str(old.resolve()))
            (candidate / "node_modules/@paperclipai/server/dist/build-info.json").write_text("tampered")
            with self.assertRaisesRegex(deploy.DeployError, "npm install failed"):
                d.stage(item, {"payload.tar.gz": {"size": 1024}})
            self.assertFalse(candidate.exists())

    def test_activate_rejects_changed_stage_migration_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli, old, candidate, current, _ = self.make_install(root)
            other = cli / "installs/npm/other"
            other.mkdir()
            migration = other / "node_modules/@paperclipai/db/dist/migrations/0001.sql"
            migration.parent.mkdir(parents=True)
            migration.write_text("same")
            d = self.configured(root, lambda *a, **k: SimpleNamespace(returncode=0))
            diff = d._migration_diff(old, candidate)
            link = cli / ".replacement"
            link.symlink_to(other)
            current.unlink()
            link.replace(current)
            with self.assertRaisesRegex(deploy.DeployError, "baseline changed"):
                d.activate(candidate, self.manifest(), diff, "token")
            self.assertEqual(current.resolve(), other.resolve())


if __name__ == "__main__":
    unittest.main()
