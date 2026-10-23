import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request


def command(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def api(path):
    return json.loads(command(['gh', 'api', path]))


def identity(provenance, controller):
    pins = sorted((p['number'], p['head']) for p in provenance['patches'])
    return hashlib.sha256(json.dumps([provenance['version'], provenance['sourceCommit'], pins, controller], separators=(',', ':')).encode()).hexdigest()


def green_run(run, manifest, repository):
    return (
        run.get('repository', {}).get('full_name') == repository
        and run.get('path') == '.github/workflows/canary-patched.yml'
        and run.get('head_sha') == manifest['controllerCommit']
        and str(run.get('run_attempt')) == str(manifest['runAttempt'])
        and run.get('event') in ('schedule', 'workflow_dispatch')
        and run.get('status') == 'completed'
        and run.get('conclusion') == 'success'
    )


def existing_green(repository, build_identity):
    for release in api(f'repos/{repository}/releases?per_page=20'):
        if release.get('draft') or not release['tag_name'].startswith('patched-canary-'):
            continue
        assets = [a for a in release.get('assets', []) if a['name'] == 'manifest.json']
        if len(assets) != 1 or assets[0]['size'] > 4_000_000:
            continue
        with urllib.request.urlopen(assets[0]['browser_download_url'], timeout=30) as response:
            manifest = json.load(response)
        if manifest.get('buildIdentity') != build_identity:
            continue
        if green_run(api(f"repos/{repository}/actions/runs/{manifest['runId']}"), manifest, repository):
            return release['tag_name']
    return None


MIGRATION_COMPAT_ASSERTIONS = {
    "migration-engine-upgrade",
    "task-retry-row-preserved",
    "candidate-schema-current",
    "migration-specific-invariants",
    "secret-scope-data-preserved",
    "restore-point-checkout-migrations",
    "migration-inventory-extension",
}
MIGRATION_BASELINE_HASH = "9cec6945b6dd1c38b80940e5246d500da8b5d506a4be68db20ab89136fc11ed9"
MIGRATION_CANDIDATE_HASH = "89cd5c4305633ac9eeabbb04a9d0584adce53afe0b2d06a6f7dab983dfe34174"
MIGRATION_OLD_VERSION = "2026.1017.0-canary.6"
MIGRATION_OLD_SRI = "sha512-ben+ng50+SxXKmXD8MCUit6yZf20i0CQBWG6ZZq44AGvnX8GF5OvLH/F9ogzXFAgEW/Kc2LXCf3qvPolcoagCg=="


def validate_migration_compatibility(manifest, controller, run_id, run_attempt):
    receipt = manifest.get("migrationCompatibilityReceipt")
    if not isinstance(receipt, dict) or receipt.get("schemaVersion") != 1:
        raise RuntimeError("Candidate is missing its migration compatibility receipt")
    proof = receipt.get("upgradeProof")
    if not isinstance(proof, dict) or proof.get("passed") is not True:
        raise RuntimeError("Migration compatibility receipt does not prove a successful upgrade")
    assertion_ids = proof.get("assertions")
    if not isinstance(assertion_ids, list) or len(assertion_ids) != len(MIGRATION_COMPAT_ASSERTIONS) or set(assertion_ids) != MIGRATION_COMPAT_ASSERTIONS:
        raise RuntimeError("Migration compatibility receipt has missing or duplicate invariant assertions")
    candidate_package = receipt.get("candidatePackage")
    provenance_package = manifest.get("npmPackages", {}).get("@paperclipai/db")
    if (
        proof.get("runId") != run_id
        or proof.get("runAttempt") != run_attempt
        or proof.get("controllerCommit") != controller
        or proof.get("sourceCommit") != manifest.get("sourceCommit")
        or proof.get("patchCommit") != manifest.get("patchedCommit")
        or receipt.get("baselineInventorySha256") != MIGRATION_BASELINE_HASH
        or receipt.get("candidateInventorySha256") != MIGRATION_CANDIDATE_HASH
        or receipt.get("baselineFileCount") != 354
        or receipt.get("candidateFileCount") != 375
        or receipt.get("baselinePackage") != {"version": MIGRATION_OLD_VERSION, "integrity": MIGRATION_OLD_SRI}
        or not isinstance(candidate_package, dict)
        or candidate_package.get("version") != manifest.get("version")
        or not isinstance(provenance_package, dict)
        or candidate_package.get("version") != provenance_package.get("version")
        or candidate_package.get("integrity") != provenance_package.get("integrity")
        or not re.fullmatch(r"\d{4}\.\d+\.0-canary\.\d+", str(candidate_package.get("version", "")))
        or not re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", str(candidate_package.get("integrity", "")))
    ):
        raise RuntimeError("Migration compatibility receipt is not bound to this exact build and reviewed package transition")
    inventory_rows = [
        item for item in manifest.get("migrations", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
        and (item["path"].endswith(".sql") or item["path"].endswith("/meta/_journal.json"))
    ]
    inventory = {item["path"]: item["sha256"] for item in inventory_rows}
    if any(not item["path"].startswith("node_modules/@paperclipai/db/dist/migrations/") or not re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", ""))) for item in inventory_rows):
        raise RuntimeError("Published migration inventory contains an invalid path or hash")
    canonical = json.dumps(dict(sorted(inventory.items())), separators=(",", ":"), sort_keys=True).encode()
    actual = hashlib.sha256(canonical).hexdigest()
    if len(inventory_rows) != 375 or len(inventory) != 375 or actual != MIGRATION_CANDIDATE_HASH or actual != receipt.get("candidateInventorySha256"):
        raise RuntimeError("Published runtime migration inventory differs from the tested upgrade receipt")


def publish(source, output, repository, controller):
    manifest_path = output / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    archive = output / 'payload.tar.gz'
    if not all(manifest.get('quality', {}).get(gate) is True for gate in ('typecheck', 'tests', 'build')):
        raise RuntimeError('Candidate has not passed all quality gates')
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['archiveSha256']:
        raise RuntimeError('Candidate archive changed after packaging')
    if command(['git', '-C', str(source), 'rev-parse', 'HEAD']) != manifest['patchedCommit']:
        raise RuntimeError('Source commit differs from verified build')
    if command(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=no']):
        raise RuntimeError('Tracked source changed after build')
    run_id = int(os.environ['GITHUB_RUN_ID'])
    run_attempt = int(os.environ['GITHUB_RUN_ATTEMPT'])
    validate_migration_compatibility(manifest, controller, run_id, run_attempt)
    manifest.update(
        buildIdentity=identity(manifest, controller),
        controllerCommit=controller,
        runId=run_id,
        runAttempt=run_attempt,
        workflowRef=os.environ['GITHUB_WORKFLOW_REF'],
    )
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    command(['gh', 'auth', 'setup-git'])
    url = f'https://github.com/{repository}.git'
    ref = 'refs/heads/deploy/canary-patched'
    old = command(['git', 'ls-remote', url, ref]).split()
    expected = old[0] if old else ''
    if old:
        prior = api(f'repos/{repository}/commits/{expected}')
        if not prior['commit']['message'].startswith('canary-train:'):
            raise RuntimeError('Refusing to replace a branch not owned by this controller')
    command(['git', '-C', str(source), 'push', f'--force-with-lease={ref}:{expected}', url, f"{manifest['patchedCommit']}:{ref}"])
    if not re.fullmatch(r'[0-9A-Za-z.-]+', manifest['version']):
        raise RuntimeError('Invalid package version')
    tag = f"patched-canary-{manifest['version']}-{manifest['runId']}-{manifest['runAttempt']}"
    body = output / 'release-notes.md'
    body.write_text(
        f"Published Canary `{manifest['version']}` with the maintained patch series.\n\n"
        f"Official source: `{manifest['sourceCommit']}`\n\n"
        f"Patched source: `{manifest['patchedCommit']}`\n\n"
        f"Build: https://github.com/{repository}/actions/runs/{manifest['runId']}\n\n"
        'Deployment is eligible only after this workflow run completes successfully.\n'
    )
    command(['gh', 'release', 'create', tag, str(manifest_path), str(archive), '--repo', repository,
             '--target', controller, '--prerelease', '--title', f"Canary {manifest['version']} + patches", '--notes-file', str(body)])
    print(f'Published {tag}; deployment waits for the successful workflow conclusion.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    repository = os.environ['GITHUB_REPOSITORY']
    controller = os.environ['GITHUB_SHA']
    if repository != 'copystring/paperclip':
        raise RuntimeError('This controller is configured only for its own fork')
    if args.check:
        provenance = json.loads((args.output / 'provenance.json').read_text())
        tag = existing_green(repository, identity(provenance, controller))
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write(f"needed={'false' if tag else 'true'}\n")
        print(f'Already green: {tag}' if tag else 'New build required')
    else:
        publish(args.source, args.output, repository, controller)


if __name__ == '__main__':
    main()
