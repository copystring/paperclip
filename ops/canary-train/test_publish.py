import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publish', Path(__file__).with_name('publish.py'))
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublicationTests(unittest.TestCase):
    def test_identity_changes_for_source_patch_or_controller_changes(self):
        base = {'version':'2026.1018.0-canary.9', 'sourceCommit':'a'*40, 'patches':[{'number':1,'head':'b'*40}]}
        value = publish.identity(base, 'c'*40)
        self.assertNotEqual(value, publish.identity(base, 'd'*40))
        changed = {**base, 'patches':[{'number':1,'head':'e'*40}]}
        self.assertNotEqual(value, publish.identity(changed, 'c'*40))

    def test_migration_receipt_is_required_and_bound_to_published_runtime(self):
        import hashlib
        inventory = {
            f"node_modules/@paperclipai/db/dist/migrations/{index:04d}_migration.sql": hashlib.sha256(str(index).encode()).hexdigest()
            for index in range(375)
        }
        inventory["node_modules/@paperclipai/db/dist/migrations/meta/_journal.json"] = hashlib.sha256(b"journal").hexdigest()
        candidate_hash = hashlib.sha256(json.dumps(dict(sorted(inventory.items())), separators=(",", ":"), sort_keys=True).encode()).hexdigest()
        assertions = sorted(publish.MIGRATION_COMPAT_ASSERTIONS)
        candidate_version = "2026.1024.0-canary.14"
        candidate_integrity = "sha512-Ub4gzp005JhteAMeDsOxUXDjbSA7OUg+dqiQ1CGaqqxB+xZpJS+x5ke5N/GkqL3f/a+DOQMDp/ZJzNC6//Uo3Q=="
        manifest = {
            "version": candidate_version,
            "sourceCommit": "a" * 40,
            "patchedCommit": "b" * 40,
            "npmPackages": {"@paperclipai/db": {"version": candidate_version, "integrity": candidate_integrity}},
            "migrations": [{"path": path, "sha256": value} for path, value in inventory.items()],
            "migrationCompatibilityReceipt": {
                "schemaVersion": 1,
                "baselineInventorySha256": publish.MIGRATION_BASELINE_HASH,
                "candidateInventorySha256": candidate_hash,
                "baselinePackage": {"version": publish.MIGRATION_OLD_VERSION, "integrity": publish.MIGRATION_OLD_SRI},
                "candidatePackage": {"version": candidate_version, "integrity": candidate_integrity},
                "baselineFileCount": 354,
                "candidateFileCount": 376,
                "upgradeProof": {"passed": True, "runId": 42, "runAttempt": 3, "controllerCommit": "c" * 40, "sourceCommit": "a" * 40, "patchCommit": "b" * 40, "assertions": assertions},
            },
        }
        with patch.object(publish, "MIGRATION_CANDIDATE_HASH", candidate_hash):
            publish.validate_migration_compatibility(manifest, "c" * 40, 42, 3)
            with self.assertRaisesRegex(RuntimeError, "missing its migration compatibility receipt"):
                publish.validate_migration_compatibility({key: value for key, value in manifest.items() if key != "migrationCompatibilityReceipt"}, "c" * 40, 42, 3)
            changed = json.loads(json.dumps(manifest))
            changed["migrationCompatibilityReceipt"]["upgradeProof"]["runAttempt"] = 2
            with self.assertRaisesRegex(RuntimeError, "not bound to this exact build"):
                publish.validate_migration_compatibility(changed, "c" * 40, 42, 3)
            missing_assertion = json.loads(json.dumps(manifest))
            missing_assertion["migrationCompatibilityReceipt"]["upgradeProof"]["assertions"].remove("committed-native-recovery-state-migration")
            with self.assertRaisesRegex(RuntimeError, "missing or duplicate invariant assertions"):
                publish.validate_migration_compatibility(missing_assertion, "c" * 40, 42, 3)
            changed_inventory = json.loads(json.dumps(manifest))
            changed_inventory["migrations"][0]["sha256"] = "f" * 64
            with self.assertRaisesRegex(RuntimeError, "differs from the tested upgrade receipt"):
                publish.validate_migration_compatibility(changed_inventory, "c" * 40, 42, 3)

    def test_only_completed_successful_controller_runs_are_green(self):
        manifest = {'controllerCommit':'c'*40, 'runAttempt':2}
        run = {'repository':{'full_name':'copystring/paperclip'}, 'path':'.github/workflows/canary-patched.yml',
               'head_sha':'c'*40, 'run_attempt':2, 'event':'schedule', 'status':'completed', 'conclusion':'success'}
        self.assertTrue(publish.green_run(run, manifest, 'copystring/paperclip'))
        for key, value in [('conclusion','failure'), ('status','in_progress'), ('head_sha','d'*40),
                           ('event','pull_request'), ('run_attempt',1), ('path','.github/workflows/other.yml')]:
            with self.subTest(key=key):
                self.assertFalse(publish.green_run({**run, key:value}, manifest, 'copystring/paperclip'))


if __name__ == '__main__':
    unittest.main()
