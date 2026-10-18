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
    manifest.update(
        buildIdentity=identity(manifest, controller),
        controllerCommit=controller,
        runId=int(os.environ['GITHUB_RUN_ID']),
        runAttempt=int(os.environ['GITHUB_RUN_ATTEMPT']),
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
