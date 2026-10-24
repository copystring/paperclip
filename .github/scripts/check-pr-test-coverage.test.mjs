import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTestCoverage } from './check-pr-test-coverage.mjs';

test('recognizes standard Python unittest and pytest filenames', () => {
  for (const filename of ['test_build.py', 'ops/train/test_build.py', 'ops/train/build_test.py']) {
    assert.equal(checkTestCoverage([{filename, status:'added'}], 'fix: repair updater').passed, true);
  }
});

test('requires tests for Python behavior changes and ignores removed tests', () => {
  assert.equal(checkTestCoverage([{filename:'ops/train/build.py', status:'modified'}], 'fix: repair updater').passed, false);
  assert.equal(checkTestCoverage([{filename:'ops/train/test_build.py', status:'removed'}], 'fix: repair updater').passed, false);
});

test('does not let Python source changes hide under a docs prefix', () => {
  assert.equal(checkTestCoverage([{filename:'ops/train/build.py', status:'added'}], 'docs: describe updater').passed, false);
  assert.equal(checkTestCoverage([{filename:'ops/train/README.md', status:'added'}], 'docs: describe updater').passed, true);
});

test('recognizes executable Node test modules with the existing test_ naming convention', () => {
  for (const filename of ['ops/canary-train/test_migration_precondition_probe.mjs', 'scripts/test_cli.cjs']) {
    assert.equal(checkTestCoverage([{filename, status:'modified'}], 'fix: await CLI').passed, true);
    assert.equal(checkTestCoverage([{filename, status:'removed'}], 'fix: await CLI').passed, false);
  }
  assert.equal(checkTestCoverage([{filename:'ops/canary-train/migration-precondition-probe.mjs', status:'modified'}], 'fix: await CLI').passed, false);
  assert.equal(checkTestCoverage([{filename:'ops/canary-train/migration-precondition-probe.mjs', status:'modified'}], 'docs: describe CLI').passed, false);
});
