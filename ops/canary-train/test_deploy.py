import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from types import SimpleNamespace

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
            "@paperclipai/db#dist": "node_modules/@paperclipai/db/dist",
        },
        "files": {
            "node_modules/paperclipai/dist/index.js": digest(b"cli"),
            "node_modules/@paperclipai/server/dist/index.js": digest(b"server"),
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
            with self.assertRaisesRegex(deploy.DeployError, "changes or removes"):
                deployer(root)._migration_diff(old, new)

    def test_migration_diff_allows_only_additive_new_migrations(self):
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
            result = deployer(root)._migration_diff(old, new)
            self.assertEqual(result["added"], [added.as_posix()])

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
                d.stage(item, {})
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


if __name__ == "__main__":
    unittest.main()
