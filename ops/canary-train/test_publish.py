import importlib.util
from pathlib import Path
import unittest

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
