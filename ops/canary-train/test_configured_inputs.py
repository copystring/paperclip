"""Check real registered inputs before starting expensive source assembly."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("configured_canary_build", ROOT / "build.py")
assert SPEC and SPEC.loader
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class ConfiguredInputTests(unittest.TestCase):
    def test_registered_compatibility_diffs_match_their_actual_pins(self):
        manifest = build.validate_manifest(json.loads((ROOT / "patches.json").read_text(encoding="utf-8")))
        for source in manifest["patches"]:
            integration = source.get("integrationPatch")
            if integration is None:
                continue
            with self.subTest(repository=source["repository"], number=source["number"]):
                path = ROOT / integration["path"]
                self.assertFalse(path.is_symlink())
                self.assertTrue(path.resolve().is_relative_to(ROOT))
                payload = path.read_bytes()
                self.assertTrue(payload, "registered integration diff is empty")
                self.assertEqual(hashlib.sha256(payload).hexdigest(), integration["sha256"])
