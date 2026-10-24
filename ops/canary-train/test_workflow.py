"""Regression checks for the canary workflow's dependency-only caches."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/canary-patched.yml"


class DependencyCacheWorkflowTests(unittest.TestCase):
    def test_native_harness_proof_uses_prepared_source_and_blocks_before_migration(self):
        job = self.text.split('  migration-fixture-check:\n', 1)[1].split('  assemble:\n', 1)[0]
        proof = re.search(r'(?ms)^      - name: Verify composed native integration scheduling\n(.*?)(?=^      - |\Z)', job)
        self.assertIsNotNone(proof, 'The source harness regression must gate composed-source qualification')
        self.assertIn('node "$RUNNER_TEMP/migration-source/scripts/__tests__/run-vitest-stable-shard.test.mjs"', proof.group(1))
        self.assertNotIn('continue-on-error', proof.group(1))
        self.assertNotIn('if:', proof.group(1), 'The regression must run for PRs as well as manual qualification')
        self.assertNotIn('||', proof.group(1))
        self.assertLess(job.index('Prepare source for disposable migration fixtures'), proof.start())
        self.assertLess(proof.start(), job.index('Verify migration fixtures before merge'))

    def test_manual_canary_input_is_quoted_and_schedule_keeps_latest_default(self):
        dispatch = self.text.split("  workflow_dispatch:\n", 1)[1].split("  schedule:\n", 1)[0]
        self.assertIn("canary_version:", dispatch)
        self.assertIn("type: string", dispatch)
        self.assertIn("required: false", dispatch)
        self.assertIn("qualification_only:", dispatch)
        self.assertIn("type: boolean", dispatch)
        self.assertIn("default: false", dispatch)
        self.assertIn("- cron: '23 3 * * *'", self.text)
        for job in ("migration-fixture-check", "assemble"):
            block = re.search(rf"(?ms)^  {re.escape(job)}:\n(.*?)(?=^  [a-z_-]+:|\Z)", self.text).group(1)
            self.assertIn("CANARY_VERSION: ${{ inputs.canary_version }}", block)
            self.assertIn('args+=(--canary-version "$CANARY_VERSION")', block)
            self.assertNotIn("${{ inputs.canary_version }}\"", block)

    def test_qualification_only_runs_read_only_checks_and_skips_release_train(self):
        fixture = re.search(r"(?ms)^  migration-fixture-check:\n(.*?)(?=^  [a-z_-]+:|\Z)", self.text).group(1)
        assemble = re.search(r"(?ms)^  assemble:\n(.*?)(?=^  [a-z_-]+:|\Z)", self.text).group(1)
        self.assertIn("inputs.qualification_only == true", fixture)
        self.assertIn("inputs.qualification_only != true", assemble)
        self.assertIn("args=(prepare", fixture)
        self.assertIn('build.py "${args[@]}"', fixture)
        self.assertIn("verify-migration-compatibility.mjs", fixture)
        self.assertNotIn("publish.py", fixture)
        self.assertNotIn("contents: write", fixture)
        self.assertNotIn("build.py build", fixture)
        self.assertNotIn("runner-artifacts", fixture)
        self.assertIn("needs: assemble", self.text)
        self.assertIn("needs: [assemble, verify-tests, runner-artifacts, migration-compatibility]", self.text)

    def test_pull_requests_prove_disposable_migration_fixtures_without_release_jobs(self):
        job = self.text.split('  migration-fixture-check:\n', 1)[1].split('  assemble:\n', 1)[0]
        self.assertIn('needs: controller-tests', job)
        self.assertIn("github.event_name == 'pull_request'", job)
        self.assertIn('runs-on: ubuntu-24.04', job)
        self.assertIn('persist-credentials: false', job)
        self.assertIn('args=(prepare', job)
        self.assertIn('build.py "${args[@]}"', job)
        self.assertIn('verify-migration-compatibility.mjs', job)
        self.assertIn('migration-output/provenance.json', job)
        self.assertIn('retention-days: 1', job)
        self.assertIn('overwrite: true', job)
        self.assertNotIn('publish.py', job)
        self.assertNotIn('contents: write', job)
        self.assertNotIn('actions/cache/', job)

    def test_daily_build_and_instance_timer_have_no_interval_trigger(self):
        self.assertEqual(self.text.count("- cron:"), 1)
        self.assertIn("- cron: '23 3 * * *'", self.text)
        timer = (ROOT / "ops/canary-train/paperclip-canary-train.timer").read_text()
        triggers = [line for line in timer.splitlines() if line.startswith("On")]
        self.assertEqual(triggers, ["OnCalendar=*-*-* 08:30:00 UTC"])
        self.assertIn("Persistent=true", timer)
        self.assertIn("Unit=paperclip-canary-train.service", timer)

    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_fingerprints_come_from_prepared_source_not_controller(self):
        self.assertEqual(self.text.count("id: dependency_cache"), 3)
        self.assertEqual(self.text.count("source / 'pnpm-lock.yaml'"), 3)
        self.assertEqual(self.text.count("source / 'packages/paperclip-runner/runner/Cargo.lock'"), 3)
        self.assertEqual(self.text.count("source / 'packages/paperclip-runner/rust-toolchain.toml'"), 3)
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
        self.assertEqual(self.text.count("uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9"), 3)
        self.assertEqual(self.text.count("uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9"), 1)
        self.assertEqual(self.text.count("steps.dependency_cache.outputs.pnpm_store"), 4)
        self.assertIn("steps.pnpm_cache.outputs.cache-hit != 'true'", self.text)
        self.assertLess(self.text.index("name: Package verified runtime output"), self.text.index("name: Save prepared Canary pnpm store"))
        self.assertNotRegex(self.text, r"(?i)cache[^\n]*node_modules|node_modules[^\n]*cache")
        self.assertNotIn("test-results", self.text)

    def test_rust_cache_is_pinned_and_excludes_workspace_crates_and_binaries(self):
        self.assertEqual(self.text.count("uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6"), 3)
        self.assertEqual(self.text.count("cache-workspace-crates: false"), 3)
        self.assertEqual(self.text.count("cache-bin: false"), 3)
        self.assertEqual(self.text.count("cache-on-failure: false"), 3)
        self.assertEqual(self.text.count("packages/paperclip-runner/runner -> target"), 3)

    def test_full_test_matrix_and_quality_gates_remain(self):
        self.assertIn("fail-fast: false", self.text)
        self.assertIn("max-parallel: 9", self.text)
        self.assertIn("build.py test --lane", self.text)
        self.assertIn("build.py build", self.text)
        self.assertIn("--test-receipts", self.text)

    def test_four_native_targets_are_built_on_matching_hosts_and_gate_publication(self):
        for target, runner in (("linux-x64", "ubuntu-24.04"), ("linux-arm64", "ubuntu-24.04-arm"),
                               ("darwin-arm64", "macos-15"), ("darwin-x64", "macos-15-intel")):
            self.assertIn(f"- target: {target}\n            runner: {runner}", self.text)
        self.assertIn("timeout-minutes: 45", self.text)
        self.assertIn("needs: [assemble, verify-tests, runner-artifacts, migration-compatibility]", self.text)
        self.assertIn("needs.runner-artifacts.result == 'success'", self.text)
        self.assertIn("--runner-artifacts", self.text)
        self.assertIn("--provider-pack", self.text)
        self.assertIn("build:provider-pack -- \"$RUNNER_TEMP/provider-pack-output\"", self.text)
        self.assertIn("canary-provider-pack", self.text)
        self.assertGreaterEqual(self.text.count("EXPECTED_SOURCE_SHA256"), 3)

    def test_migration_evidence_uses_frozen_source_and_gates_package(self):
        job = self.text.split("  migration-compatibility:\n", 1)[1].split("  runner-artifacts:\n", 1)[0]
        self.assertIn("needs: assemble", job)
        self.assertIn("EXPECTED_SOURCE_SHA256", job)
        self.assertIn("verify-migration-compatibility.mjs", job)
        self.assertIn('"$RUNNER_TEMP/paperclip-output/provenance.json"', job)
        self.assertIn("if-no-files-found: error", job)
        self.assertIn("needs.migration-compatibility.result == 'success'", self.text)
        self.assertIn('--migration-receipt "$RUNNER_TEMP/paperclip-migration-compatibility/receipt.json"', self.text)


if __name__ == "__main__":
    unittest.main()
