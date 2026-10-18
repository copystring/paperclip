"""Regression checks for the canary workflow's dependency-only caches."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/canary-patched.yml"


class DependencyCacheWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_fingerprints_come_from_prepared_source_not_controller(self):
        self.assertEqual(self.text.count("id: dependency_cache"), 2)
        self.assertEqual(self.text.count("source / 'pnpm-lock.yaml'"), 2)
        self.assertEqual(self.text.count("source / 'packages/paperclip-runner/runner/Cargo.lock'"), 2)
        self.assertEqual(self.text.count("source / 'packages/paperclip-runner/rust-toolchain.toml'"), 2)
        self.assertNotIn("hashFiles(", self.text)
        self.assertIn("pnpm_lock_sha", self.text)
        self.assertIn("rust_inputs_sha", self.text)

    def test_only_trusted_master_runs_restore_or_save_caches(self):
        trusted = (
            "github.repository == 'copystring/paperclip' && "
            "github.ref == 'refs/heads/master' && "
            "(github.event_name == 'workflow_dispatch' || github.event_name == 'schedule')"
        )
        self.assertGreaterEqual(self.text.count(trusted), 4)
        for step in re.findall(r"(?ms)^      - name: .*?\n(?=      - name:|  [a-z_-]+:|\Z)", self.text):
            if "actions/cache/restore@" in step or "actions/cache/save@" in step:
                self.assertIn(trusted, step)

    def test_pnpm_cache_contains_only_candidate_store_and_is_saved_after_build(self):
        self.assertEqual(self.text.count("uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9"), 2)
        self.assertEqual(self.text.count("uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9"), 1)
        self.assertEqual(self.text.count("steps.dependency_cache.outputs.pnpm_store"), 3)
        self.assertIn("steps.pnpm_cache.outputs.cache-hit != 'true'", self.text)
        self.assertLess(self.text.index("name: Package verified runtime output"), self.text.index("name: Save prepared Canary pnpm store"))
        self.assertNotRegex(self.text, r"(?i)cache[^\n]*node_modules|node_modules[^\n]*cache")
        self.assertNotIn("test-results", self.text)

    def test_rust_cache_is_pinned_and_excludes_workspace_crates_and_binaries(self):
        self.assertEqual(self.text.count("uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6"), 2)
        self.assertEqual(self.text.count("cache-workspace-crates: false"), 2)
        self.assertEqual(self.text.count("cache-bin: false"), 2)
        self.assertEqual(self.text.count("cache-on-failure: false"), 2)
        self.assertEqual(self.text.count("packages/paperclip-runner/runner -> target"), 2)

    def test_full_test_matrix_and_quality_gates_remain(self):
        self.assertIn("fail-fast: false", self.text)
        self.assertIn("max-parallel: 9", self.text)
        self.assertIn("build.py test --lane", self.text)
        self.assertIn("build.py build", self.text)
        self.assertIn("--test-receipts", self.text)


if __name__ == "__main__":
    unittest.main()
