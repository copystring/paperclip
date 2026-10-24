#!/usr/bin/env python3
"""Resolve, patch, build, and package an integrity-indexed Paperclip canary overlay."""
from __future__ import annotations

import argparse
import base64
from datetime import date
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


HEX40 = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
PACKAGE_NAME = re.compile(r"^(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+$")
CALVER_CANARY_VERSION = re.compile(r"^(\d{4})\.([1-9]|1[0-2])(\d{2})\.(0|[1-9]\d*)-canary\.(0|[1-9]\d*)$")
DEFAULT_PACKAGES = ("paperclipai", "@paperclipai/server")
REGISTRY = "https://registry.npmjs.org"
GITHUB_API = "https://api.github.com"
PATCH_BRANCH = "deploy/canary-patched"
TEST_PLAN_SCHEMA = 1
EXPECTED_GENERAL_GROUPS = {
    "general-server", "general-server-without-chat", "general-server-without-chat-or-native-runner",
    "general-chat", "general-server-native-runner", "general-workspaces-a", "general-workspaces-b",
    "general-workspaces-c",
}
NATIVE_RUNNER_TEST_MARKERS = (
    'execFileSync("cargo"', "execFileSync('cargo'",
    "existsSync(defaultCapabilityRunnerdBinary())", "existsSync(fakeCodexAppServer)",
)
RELEASE_SKILLS_PACKAGE_DIRS = {"server", "packages/adapters/claude-local", "packages/adapters/codex-local"}
OPTIONAL_EMPTY_SKILLS_PACKAGE_DIRS = {
    "packages/adapters/cursor-local", "packages/adapters/gemini-local", "packages/adapters/opencode-local",
}
DEPENDENCY_FILES = {
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json",
    "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", ".npmrc",
}
RUNNER_RELEASE_TARGETS = ("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64")


class TrainError(RuntimeError):
    """A fail-closed build-controller error."""


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify_npm_integrity(payload: bytes, integrity: str) -> str:
    """Verify one strongest supported npm SRI digest."""
    strengths = {"sha256": 1, "sha384": 2, "sha512": 3}
    candidates = []
    for token in integrity.split():
        match = re.fullmatch(r"(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?", token)
        if match:
            algorithm, encoded = match.groups()
            candidates.append((strengths[algorithm], algorithm, encoded))
    if not candidates:
        raise TrainError("npm metadata has no supported integrity digest")
    for _, algorithm, expected in sorted(candidates, reverse=True):
        actual = base64.b64encode(hashlib.new(algorithm, payload).digest()).decode("ascii")
        if actual == expected:
            return algorithm
    raise TrainError("npm tarball integrity verification failed")


def safe_relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise TrainError(f"unsafe archive path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise TrainError(f"unsafe archive path: {value!r}")
    if re.match(r"^[A-Za-z]:", path.parts[0]):
        raise TrainError(f"unsafe archive path: {value!r}")
    return path


def parse_server_build_commit(tarball: bytes, integrity: str, version: str) -> str:
    """Integrity-check server tarball and read only its authoritative build stamp."""
    verify_npm_integrity(tarball, integrity)
    try:
        import io
        with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
            pkg = archive.getmember("package/package.json")
            stamp = archive.getmember("package/dist/build-info.json")
            if not pkg.isfile() or not stamp.isfile():
                raise TrainError("server tarball is missing package.json or dist/build-info.json")
            package_json = json.load(archive.extractfile(pkg))
            build_info = json.load(archive.extractfile(stamp))
    except (tarfile.TarError, KeyError, json.JSONDecodeError, OSError) as exc:
        raise TrainError(f"cannot inspect server npm tarball: {exc}") from exc
    if package_json.get("name") != "@paperclipai/server" or package_json.get("version") != version:
        raise TrainError("server tarball identity differs from synchronized npm canary")
    commit = build_info.get("commit") if isinstance(build_info, dict) else None
    if not isinstance(commit, str) or not HEX40.fullmatch(commit):
        raise TrainError("server tarball has no valid dist/build-info.json commit")
    return commit.lower()


def verify_npm_tarball_identity(tarball: bytes, integrity: str, name: str, version: str) -> str:
    verify_npm_integrity(tarball, integrity)
    try:
        import io
        with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
            member = archive.getmember("package/package.json")
            if not member.isfile():
                raise TrainError(f"{name} tarball package.json is not a regular file")
            package_json = json.load(archive.extractfile(member))
    except (tarfile.TarError, KeyError, json.JSONDecodeError, OSError) as exc:
        raise TrainError(f"cannot inspect {name} npm tarball: {exc}") from exc
    if package_json.get("name") != name or package_json.get("version") != version:
        raise TrainError(f"{name} tarball identity does not match synchronized canary")
    return sha256(tarball)


def validate_manifest(manifest: Any) -> dict[str, Any]:
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise TrainError("manifest must have schemaVersion 1")
    upstream = manifest.get("upstreamRepository")
    if upstream != "paperclipai/paperclip":
        raise TrainError("upstreamRepository must be the official paperclipai/paperclip repository")
    if manifest.get("packageNames") != list(DEFAULT_PACKAGES):
        raise TrainError("packageNames must be paperclipai and @paperclipai/server in that order")
    patches = manifest.get("patches")
    if not isinstance(patches, list):
        raise TrainError("patches must be an array")
    seen = set()
    for patch in patches:
        if not isinstance(patch, dict):
            raise TrainError("each patch entry must be an object")
        number, head, repository = patch.get("number"), patch.get("head"), patch.get("repository")
        if not isinstance(number, int) or number <= 0 or not isinstance(head, str) or not HEX40.fullmatch(head):
            raise TrainError("each pinned PR needs a positive number and full 40-character head SHA")
        if not isinstance(repository, str) or not REPOSITORY.fullmatch(repository):
            raise TrainError(f"PR #{number} repository must be owner/repository")
        integration = patch.get("integrationPatch")
        if integration is not None:
            if not isinstance(integration, dict) or integration.get("number") != number:
                raise TrainError(f"PR #{number} integrationPatch must identify the same PR number")
            try:
                safe_relative_path(integration.get("path"))
            except TrainError as exc:
                raise TrainError(f"PR #{number} integration patch path is invalid") from exc
            if not re.fullmatch(r"[0-9a-f]{64}", str(integration.get("sha256", ""))):
                raise TrainError(f"PR #{number} integration patch requires a pinned SHA256")
        key = (repository.lower(), number)
        if key in seen:
            raise TrainError(f"duplicate pinned PR {repository}#{number}")
        seen.add(key)
    return manifest


def validate_patch_paths(paths: Iterable[str]) -> None:
    rejected = []
    for raw in paths:
        path = safe_relative_path(raw)
        if path.name == "package.json" or path.name in DEPENDENCY_FILES or path.name.endswith((".lock", ".lockb")):
            rejected.append(raw)
    if rejected:
        raise TrainError("PR changes dependency/package metadata unsupported by this overlay: " + ", ".join(sorted(rejected)))


def patch_state(merge_is_ancestor: bool, reverse_apply_succeeds: bool, forward_apply_succeeds: bool) -> str:
    """Return the only permitted patch decisions, in their required precedence."""
    if merge_is_ancestor:
        return "already_in_release"
    if reverse_apply_succeeds:
        return "already_present"
    if forward_apply_succeeds:
        return "apply"
    raise TrainError("pinned PR diff conflicts with this exact canary source")


def apply_pinned_patch(
    workspace: Path,
    repository: str,
    number: int,
    head: str,
    patch_bytes: bytes,
    changed_paths: list[str],
    integration_patch: tuple[bytes, str] | None = None,
    fetch_url: str | None = None,
) -> str:
    """Apply exact PR diff, using Git's verified blob-based three-way merge if needed."""
    reverse = git(workspace, "apply", "--reverse", "--check", "-", input_bytes=patch_bytes, check=False)
    if reverse.returncode == 0:
        return "already_present"
    forward = git(workspace, "apply", "--check", "-", input_bytes=patch_bytes, check=False)
    if forward.returncode == 0:
        git(workspace, "apply", "-", input_bytes=patch_bytes)
        return "applied"

    # GitHub's unified diff includes the base blob IDs. Fetch the exact pinned
    # PR head so Git can locate those blobs and merge overlapping context
    # changes. No conflict is resolved automatically: any failed or unmerged
    # result stops the train for an explicit patch review.
    url = fetch_url or f"https://github.com/{repository}.git"
    git(workspace, "fetch", "--quiet", "--no-tags", url, f"refs/pull/{number}/head")
    fetched = git(workspace, "rev-parse", "FETCH_HEAD").stdout.decode().strip().lower()
    if fetched != head.lower():
        raise TrainError(f"PR #{number} fetched head differs from the pinned SHA")
    merged = git(workspace, "apply", "--3way", "--index", "-", input_bytes=patch_bytes, check=False)
    if merged.returncode != 0:
        restore_patch_paths(workspace, changed_paths)
        if integration_patch is not None:
            integration_bytes, integration_sha = integration_patch
            numstat = git(workspace, "apply", "--numstat", "-z", "-", input_bytes=integration_bytes, check=False)
            if numstat.returncode != 0:
                raise TrainError(f"PR #{number} reviewed integration patch is invalid")
            patch_paths = []
            for entry in numstat.stdout.decode("utf-8", "surrogateescape").split("\0"):
                if not entry:
                    continue
                fields = entry.split("\t", 2)
                if len(fields) != 3:
                    raise TrainError(f"PR #{number} integration patch has an invalid file inventory")
                patch_paths.append(safe_relative_path(fields[2]).as_posix())
            if set(patch_paths) != set(changed_paths):
                raise TrainError(f"PR #{number} integration patch paths differ from the pinned PR paths")
            reverse_integration = git(workspace, "apply", "--reverse", "--check", "-", input_bytes=integration_bytes, check=False)
            if reverse_integration.returncode == 0:
                return "already_present_integration"
            direct_integration = git(workspace, "apply", "--check", "-", input_bytes=integration_bytes, check=False)
            if direct_integration.returncode != 0:
                raise TrainError(f"PR #{number} reviewed integration patch does not apply cleanly")
            git(workspace, "apply", "-", input_bytes=integration_bytes)
            return "applied_integration"
        raise TrainError(f"pinned PR #{number} three-way patch application failed; conflicts require review")
    status = git(workspace, "status", "--porcelain", "-z").stdout.decode("utf-8", "surrogateescape")
    if any(row[:2] in {"UU", "AA", "DD", "AU", "UA", "DU", "UD"} for row in status.split("\0") if row):
        raise TrainError(f"pinned PR #{number} left unresolved index conflicts")
    return "applied_three_way"


def restore_patch_paths(workspace: Path, changed_paths: list[str]) -> None:
    """Discard only failed-application changes to paths returned by the PR API."""
    paths = [safe_relative_path(path).as_posix() for path in changed_paths]
    if not paths:
        raise TrainError("cannot restore a failed PR patch without its verified path list")
    git(workspace, "restore", "--source=HEAD", "--staged", "--worktree", "--", *paths, check=False)
    git(workspace, "clean", "-f", "--", *paths, check=False)
    if git(workspace, "status", "--porcelain").stdout:
        raise TrainError("failed three-way application left changes outside the pinned PR paths")


def http_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json, application/json", "User-Agent": "paperclip-canary-patch-train/1"})
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token and url.startswith(GITHUB_API + "/"):
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            value = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise TrainError(f"request failed for {url}: {exc}") from exc
    if not isinstance(value, dict):
        raise TrainError(f"unexpected JSON response from {url}")
    return value


def http_json_value(url: str) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "paperclip-canary-patch-train/1"})
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token and url.startswith(GITHUB_API + "/"):
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise TrainError(f"request failed for {url}: {exc}") from exc


def http_bytes(url: str, accept: str = "application/octet-stream") -> bytes:
    request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "paperclip-canary-patch-train/1"})
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token and url.startswith(GITHUB_API + "/"):
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        raise TrainError(f"download failed from {url}: {exc}") from exc


def npm_url(name: str, endpoint: str) -> str:
    if not PACKAGE_NAME.fullmatch(name):
        raise TrainError(f"invalid npm package name: {name!r}")
    return f"{REGISTRY}/{urllib.parse.quote(name, safe='@')}/{endpoint}"


def validate_canary_version(version: str) -> str:
    """Accept only a dated Paperclip prerelease, never an arbitrary registry selector."""
    match = CALVER_CANARY_VERSION.fullmatch(version) if isinstance(version, str) else None
    if not match:
        raise TrainError("canary version must use YYYY.MDD.P-canary.N or YYYY.MMDD.P-canary.N format")
    year, month_text, day_text, _patch, _sequence = match.groups()
    try:
        date(int(year), int(month_text), int(day_text))
    except ValueError as exc:
        raise TrainError("canary version contains an invalid calendar date") from exc
    return version


def resolve_canary(canary_version: str | None = None) -> tuple[str, dict[str, dict[str, Any]], str]:
    pinned_version = validate_canary_version(canary_version) if canary_version is not None else None
    docs: dict[str, dict[str, Any]] = {}
    versions = {}
    for name in DEFAULT_PACKAGES:
        endpoint = pinned_version if pinned_version is not None else "canary"
        doc = http_json(npm_url(name, endpoint))
        version = doc.get("version")
        if not isinstance(version, str) or not version:
            raise TrainError(f"npm canary tag is missing for {name}")
        if doc.get("name") != name or doc.get("version") != version or not isinstance(doc.get("dist", {}).get("tarball"), str):
            raise TrainError(f"npm metadata identity mismatch for {name}@{endpoint}")
        if pinned_version is not None and version != pinned_version:
            raise TrainError(f"npm metadata for {name} does not match requested Canary {pinned_version}")
        docs[name], versions[name] = doc, version
    if versions[DEFAULT_PACKAGES[0]] != versions[DEFAULT_PACKAGES[1]]:
        raise TrainError("npm paperclipai and @paperclipai/server canary versions are not synchronized")
    version = versions[DEFAULT_PACKAGES[0]]
    server_tar = http_bytes(docs["@paperclipai/server"]["dist"]["tarball"])
    source_commit = parse_server_build_commit(server_tar, docs["@paperclipai/server"]["dist"].get("integrity", ""), version)
    cli_tar = http_bytes(docs["paperclipai"]["dist"]["tarball"])
    docs["@paperclipai/server"]["_verifiedTarballSha256"] = sha256(server_tar)
    docs["paperclipai"]["_verifiedTarballSha256"] = verify_npm_tarball_identity(
        cli_tar, docs["paperclipai"]["dist"].get("integrity", ""), "paperclipai", version
    )
    db_doc = http_json(npm_url("@paperclipai/db", version))
    if (
        db_doc.get("name") != "@paperclipai/db"
        or db_doc.get("version") != version
        or not isinstance(db_doc.get("dist", {}).get("tarball"), str)
        or not re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", str(db_doc.get("dist", {}).get("integrity", "")))
    ):
        raise TrainError("database package metadata does not match synchronized Canary version")
    db_tar = http_bytes(db_doc["dist"]["tarball"])
    db_doc["_verifiedTarballSha256"] = verify_npm_tarball_identity(
        db_tar, db_doc["dist"]["integrity"], "@paperclipai/db", version
    )
    docs["@paperclipai/db"] = db_doc
    return version, docs, source_commit


def git(cwd: Path, *args: str, input_bytes: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(["git", *args], cwd=cwd, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise TrainError(f"git {' '.join(args[:4])} failed: {detail}")
    return result


def is_ancestor(cwd: Path, ancestor: str, commit: str) -> bool:
    return git(cwd, "merge-base", "--is-ancestor", ancestor, commit, check=False).returncode == 0


def prepare(workspace: Path, output: Path, manifest: dict[str, Any], manifest_path: Path | None = None,
            canary_version: str | None = None) -> dict[str, Any]:
    version, npm_docs, source_commit = resolve_canary(canary_version)
    if workspace.exists() and any(workspace.iterdir()):
        raise TrainError("workspace must be new or empty; refusing to overwrite existing files")
    workspace.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{manifest['upstreamRepository']}.git"
    subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", url, str(workspace)], check=True)
    git(workspace, "checkout", "--quiet", "--detach", source_commit)
    if git(workspace, "rev-parse", "HEAD").stdout.decode().strip().lower() != source_commit:
        raise TrainError("Git source does not match the commit stamped in the verified npm server tarball")
    source_tree = git(workspace, "rev-parse", "HEAD^{tree}").stdout.decode().strip().lower()
    git(workspace, "switch", "--quiet", "-c", PATCH_BRANCH)
    statuses = []
    for patch in manifest["patches"]:
        number, repository, head = patch["number"], patch["repository"], patch["head"].lower()
        pr = http_json(f"{GITHUB_API}/repos/{repository}/pulls/{number}")
        row: dict[str, Any] = {"number": number, "repository": repository, "head": head}
        merge_sha = pr.get("merge_commit_sha")
        merged_ancestor = bool(pr.get("merged_at") and isinstance(merge_sha, str) and HEX40.fullmatch(merge_sha) and is_ancestor(workspace, merge_sha, source_commit))
        if merged_ancestor:
            row.update(state="already_in_release", mergeCommit=merge_sha.lower())
            statuses.append(row)
            continue
        if str(pr.get("head", {}).get("sha", "")).lower() != head:
            raise TrainError(f"PR #{number} head changed; update the pinned manifest explicitly")
        patch_bytes = http_bytes(f"https://github.com/{repository}/pull/{number}.diff", "text/plain")
        # Close the tiny race between validating the pinned head and reading its
        # diff. A PR that moved while we fetched it requires a manifest update.
        pr_after = http_json(f"{GITHUB_API}/repos/{repository}/pulls/{number}")
        if str(pr_after.get("head", {}).get("sha", "")).lower() != head:
            raise TrainError(f"PR #{number} moved while its pinned diff was being fetched")
        files = pr_after.get("changed_files")
        paths: list[str] = []
        page = 1
        while True:
            file_rows = http_json_value(f"{GITHUB_API}/repos/{repository}/pulls/{number}/files?per_page=100&page={page}")
            if not isinstance(file_rows, list):
                raise TrainError(f"unexpected changed-file response for PR #{number}")
            paths.extend(str(row.get("filename", "")) for row in file_rows if isinstance(row, dict))
            if len(file_rows) < 100:
                break
            page += 1
        if isinstance(files, int) and files != len(paths):
            raise TrainError(f"PR #{number} file listing is incomplete; refusing a partial patch")
        validate_patch_paths(paths)
        if not patch_bytes:
            raise TrainError(f"PR #{number} has no source changes")
        integration_pin = patch.get("integrationPatch")
        integration_input = None
        integration_path = None
        if integration_pin is not None:
            if manifest_path is None:
                raise TrainError(f"PR #{number} integration patch requires the manifest file path")
            manifest_root = manifest_path.resolve().parent
            integration_path = (manifest_root / Path(*safe_relative_path(integration_pin["path"]).parts)).resolve()
            if not integration_path.is_relative_to(manifest_root):
                raise TrainError(f"PR #{number} integration patch escapes the controller manifest directory")
            integration_bytes = integration_path.read_bytes()
            integration_sha = sha256(integration_bytes)
            if integration_sha != integration_pin["sha256"]:
                raise TrainError(f"PR #{number} integration patch digest differs from the manifest pin")
            integration_input = (integration_bytes, integration_sha)
        state = apply_pinned_patch(workspace, repository, number, head, patch_bytes, paths, integration_input)
        if state in {"already_present", "already_present_integration"}:
            row.update(state=state, diffSha256=sha256(patch_bytes))
            if integration_pin is not None:
                row["integrationPatch"] = {
                    "path": integration_pin["path"], "sha256": integration_input[1],
                    "changedPaths": paths, "used": False,
                }
            statuses.append(row)
            continue
        git(workspace, "add", "--all")
        staged = git(workspace, "diff", "--cached", "--name-only", "-z").stdout.decode("utf-8", "surrogateescape").split("\0")
        validate_patch_paths(path for path in staged if path)
        git(workspace, "diff", "--cached", "--check")
        message = f"build(canary): apply pinned PR #{number}\n\nPinned-PR: {repository}#{number}\nPinned-Head: {head}\nPatch-SHA256: {sha256(patch_bytes)}"
        git(workspace, "-c", "user.name=Paperclip Canary Patch Train", "-c", "user.email=canary-patch-train@users.noreply.github.com", "commit", "--no-gpg-sign", "-m", message)
        row.update(state=state, diffSha256=sha256(patch_bytes), changedPaths=paths)
        if integration_pin is not None:
            row["integrationPatch"] = {
                "path": integration_pin["path"],
                "sha256": integration_input[1],
                "changedPaths": paths,
                "used": state == "applied_integration",
            }
        statuses.append(row)
    marker_path = workspace / ".canary-train.json"
    if marker_path.exists():
        raise TrainError("upstream source already contains .canary-train.json; refusing to replace it")
    marker = {
        "schemaVersion": 1,
        "version": version,
        "sourceCommit": source_commit,
        "patches": [
            {
                "number": item["number"], "repository": item["repository"], "head": item["head"].lower(),
                "state": row["state"],
                **({"integrationPatch": row["integrationPatch"]} if "integrationPatch" in row else {}),
            }
            for item, row in zip(manifest["patches"], statuses, strict=True)
        ],
    }
    marker_path.write_bytes(canonical_json(marker))
    git(workspace, "add", "--", ".canary-train.json")
    git(workspace, "-c", "user.name=Paperclip Canary Patch Train", "-c", "user.email=canary-patch-train@users.noreply.github.com", "commit", "--no-gpg-sign", "-m", f"canary-train: assemble {version} from {source_commit[:12]}")
    patch_commit = git(workspace, "rev-parse", "HEAD").stdout.decode().strip().lower()
    patch_tree = git(workspace, "rev-parse", "HEAD^{tree}").stdout.decode().strip().lower()
    if git(workspace, "branch", "--show-current").stdout.decode().strip() != PATCH_BRANCH:
        raise TrainError("prepared source is not on deploy/canary-patched")
    if git(workspace, "status", "--porcelain").stdout:
        raise TrainError("prepared source is dirty after PR application")
    provenance = {
        "schemaVersion": 1,
        "version": version,
        "upstreamRepository": manifest["upstreamRepository"],
        "sourceCommit": source_commit,
        "sourceTree": source_tree,
        "branch": PATCH_BRANCH,
        "patchCommit": patch_commit,
        "patchedCommit": patch_commit,
        "patchTree": patch_tree,
        "npmPackages": {
            name: {
                "version": npm_docs[name]["version"],
                "integrity": npm_docs[name]["dist"].get("integrity"),
                "tarballSha256": npm_docs[name]["_verifiedTarballSha256"],
            } for name in (*DEFAULT_PACKAGES, "@paperclipai/db")
        },
        "patches": statuses,
    }
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "provenance.json", provenance)
    return provenance


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_bytes(canonical_json(value))
    os.replace(temp, path)


def load_provenance(workspace: Path, output: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    path = output / "provenance.json"
    if not path.is_file():
        raise TrainError("provenance.json missing; run prepare first")
    provenance = json.loads(path.read_text(encoding="utf-8"))
    if provenance.get("schemaVersion") != 1 or not HEX40.fullmatch(str(provenance.get("sourceCommit", ""))) or not HEX40.fullmatch(str(provenance.get("patchCommit", ""))):
        raise TrainError("provenance.json is invalid")
    if git(workspace, "rev-parse", "HEAD").stdout.decode().strip().lower() != provenance["patchCommit"]:
        raise TrainError("workspace HEAD differs from the immutable prepared patch commit")
    if git(workspace, "branch", "--show-current").stdout.decode().strip() != PATCH_BRANCH:
        raise TrainError("workspace is not on deploy/canary-patched")
    if git(workspace, "status", "--porcelain").stdout:
        raise TrainError("workspace has uncommitted changes")
    subject = git(workspace, "show", "-s", "--format=%s", "HEAD").stdout.decode().strip()
    if not subject.startswith("canary-train:"):
        raise TrainError("prepared commit subject must start with canary-train:")
    marker_path = workspace / ".canary-train.json"
    if not marker_path.is_file():
        raise TrainError("prepared source is missing .canary-train.json")
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    if (
        any(marker.get(field) != provenance.get(field) for field in ("schemaVersion", "version", "sourceCommit"))
        or marker.get("schemaVersion") != 1
        or marker.get("patches") != [
            {
                "number": row.get("number"), "repository": row.get("repository"), "head": row.get("head"),
                "state": row.get("state"),
                **({"integrationPatch": row["integrationPatch"]} if "integrationPatch" in row else {}),
            }
            for row in provenance.get("patches", [])
        ]
    ):
        raise TrainError(".canary-train.json does not match the prepared public provenance")
    changed = git(workspace, "diff", "--name-only", provenance["sourceCommit"], provenance["patchCommit"]).stdout.decode("utf-8", "surrogateescape").splitlines()
    validate_patch_paths(changed)
    release_packages = json.loads((workspace / "scripts" / "release-package-manifest.json").read_text(encoding="utf-8"))
    validate_patch_runtime_paths(workspace, release_packages, changed)
    return provenance, release_packages


def clean_child_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    return env


def run_checked(command: list[str], workspace: Path) -> None:
    print("+ " + " ".join(command), flush=True)
    subprocess.run(command, cwd=workspace, check=True, env=clean_child_env())


def wrapper_dry_run(workspace: Path, *flags: str) -> dict[str, Any]:
    command = ["node", "scripts/run-vitest-stable.mjs", *flags, "--dry-run"]
    completed = subprocess.run(command, cwd=workspace, check=True, text=True, stdout=subprocess.PIPE, env=clean_child_env())
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise TrainError("upstream test wrapper returned invalid dry-run JSON") from exc
    if not isinstance(value, dict):
        raise TrainError("upstream test wrapper dry-run contract is invalid")
    return value


def _unique_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise TrainError(f"upstream dry-run {label} contract is invalid")
    if len(value) != len(set(value)):
        raise TrainError(f"upstream dry-run {label} contains duplicates")
    return value


def native_runner_prerequisite_files(workspace: Path, suites: list[str]) -> list[str]:
    """Find selected test files that build or require local Runner binaries."""
    root = workspace.resolve()
    required = []
    for suite in suites:
        relative = safe_relative_path(suite)
        resolved = workspace.joinpath(*relative.parts).resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise TrainError(f"test suite escapes the prepared source or is not a file: {suite}")
        contents = resolved.read_text(encoding="utf-8")
        if any(marker in contents for marker in NATIVE_RUNNER_TEST_MARKERS):
            required.append(relative.as_posix())
    return required


def create_test_plan(workspace: Path, output: Path) -> dict[str, Any]:
    provenance, _ = load_provenance(workspace, output)
    inventory = wrapper_dry_run(workspace, "--mode", "all")
    groups = inventory.get("availableGeneralGroups")
    if not isinstance(groups, list) or set(groups) != EXPECTED_GENERAL_GROUPS or len(groups) != len(EXPECTED_GENERAL_GROUPS):
        raise TrainError("upstream general test group contract is unknown or duplicated")
    serialized_all = _unique_string_list(inventory.get("selectedSerializedSuites"), "serialized suites")
    if inventory.get("mode") != "all":
        raise TrainError("upstream all dry-run returned an unexpected mode")

    server_shards: list[list[str]] = []
    native_files_by_shard: list[list[str]] = []
    for index in range(4):
        result = wrapper_dry_run(
            workspace, "--mode", "general", "--group", "general-server",
            "--shard-index", str(index), "--shard-count", "4",
        )
        shard_files = _unique_string_list(result.get("selectedGeneralServerSuites"), "general-server suites")
        server_shards.append(shard_files)
        native_files_by_shard.append(native_runner_prerequisite_files(workspace, shard_files))
    server_inventory_result = wrapper_dry_run(
        workspace, "--mode", "general", "--group", "general-server",
        "--shard-index", "0", "--shard-count", "1",
    )
    server_inventory = _unique_string_list(server_inventory_result.get("selectedGeneralServerSuites"), "complete general-server inventory")
    flattened_server = [item for shard in server_shards for item in shard]
    expected_server_count = inventory.get("generalServerSuiteCount")
    if (
        not isinstance(expected_server_count, int) or expected_server_count < 1
        or len(flattened_server) != len(set(flattened_server))
        or len(flattened_server) != expected_server_count
        or len(server_inventory) != expected_server_count
        or set(flattened_server) != set(server_inventory)
    ):
        raise TrainError("general-server shards are not a complete disjoint partition of the upstream inventory")
    native_inventory = wrapper_dry_run(workspace, "--mode", "general", "--group", "general-server-native-runner")
    native_suites = _unique_string_list(native_inventory.get("selectedGeneralServerSuites"), "native-runner suites")
    if not native_suites or not set(native_suites).issubset(set(flattened_server)):
        raise TrainError("general-server shards omit native-runner suites")

    serialized_shards: list[list[str]] = []
    for index in range(2):
        result = wrapper_dry_run(workspace, "--mode", "serialized", "--shard-index", str(index), "--shard-count", "2")
        serialized_shards.append(_unique_string_list(result.get("selectedSerializedSuites"), "serialized suites"))
    flattened_serialized = [item for shard in serialized_shards for item in shard]
    if (
        len(flattened_serialized) != len(set(flattened_serialized))
        or set(flattened_serialized) != set(serialized_all)
        or len(flattened_serialized) != len(serialized_all)
    ):
        raise TrainError("serialized shards are not a complete disjoint partition of the upstream inventory")

    lane_specs = [
        (f"general-server-{index + 1}-of-4", "general", "general-server", index, 4)
        for index in range(4)
    ]
    workspace_projects: dict[str, list[str]] = {}
    for group in ("general-workspaces-a", "general-workspaces-b", "general-workspaces-c"):
        result = wrapper_dry_run(workspace, "--mode", "general", "--group", group)
        if result.get("workspaceProjects") is None:
            raise TrainError(f"upstream workspace group has no project contract: {group}")
        projects = _unique_string_list(result.get("workspaceProjects"), f"{group} projects")
        if not projects:
            raise TrainError(f"upstream workspace group is empty: {group}")
        if set().union(*workspace_projects.values()).intersection(projects):
            raise TrainError("upstream workspace project groups overlap")
        workspace_projects[group] = projects
        lane_specs.append((group, "general", group, 0, 1))
    lane_specs.extend((f"serialized-{index + 1}-of-2", "serialized", "serialized", index, 2) for index in range(2))
    lanes = []
    for lane_id, mode, group, index, count in lane_specs:
        native_files = native_files_by_shard[index] if group == "general-server" else []
        lanes.append({
            "id": lane_id, "mode": mode, "group": group, "shardIndex": index, "shardCount": count,
            "nativeRunnerFiles": native_files,
            "nativeRunnerPreflight": bool(native_files),
        })
    if len(lanes) != 9 or len({lane["id"] for lane in lanes}) != 9:
        raise TrainError("internal lane plan is incomplete or duplicated")
    plan = {
        "schemaVersion": TEST_PLAN_SCHEMA,
        "sourceCommit": provenance["sourceCommit"],
        "patchCommit": provenance["patchCommit"],
        "patchTree": provenance["patchTree"],
        "serverInventoryCount": expected_server_count,
        "serializedInventoryCount": len(serialized_all),
        "workspaceProjects": workspace_projects,
        "lanes": lanes,
    }
    write_json(output / "test-plan.json", plan)
    return plan


def load_test_plan(path: Path, provenance: dict[str, Any]) -> dict[str, Any]:
    if not path.is_file():
        raise TrainError("test-plan.json is missing")
    plan = json.loads(path.read_text(encoding="utf-8"))
    if (
        plan.get("schemaVersion") != TEST_PLAN_SCHEMA
        or plan.get("sourceCommit") != provenance.get("sourceCommit")
        or plan.get("patchCommit") != provenance.get("patchCommit")
        or plan.get("patchTree") != provenance.get("patchTree")
    ):
        raise TrainError("test plan does not match immutable source and patch provenance")
    lanes = plan.get("lanes")
    expected = [
        {"id": f"general-server-{i + 1}-of-4", "mode": "general", "group": "general-server", "shardIndex": i, "shardCount": 4}
        for i in range(4)
    ]
    expected += [
        {"id": group, "mode": "general", "group": group, "shardIndex": 0, "shardCount": 1}
        for group in ("general-workspaces-a", "general-workspaces-b", "general-workspaces-c")
    ]
    expected += [
        {"id": f"serialized-{i + 1}-of-2", "mode": "serialized", "group": "serialized", "shardIndex": i, "shardCount": 2}
        for i in range(2)
    ]
    if not isinstance(lanes, list) or len(lanes) != len(expected):
        raise TrainError("test plan lane set or inventory metadata is invalid")
    for lane, base in zip(lanes, expected, strict=True):
        if not isinstance(lane, dict) or any(lane.get(key) != value for key, value in base.items()):
            raise TrainError("test plan lane set or inventory metadata is invalid")
        native_files = _unique_string_list(lane.get("nativeRunnerFiles"), "native Runner test files")
        if (
            lane.get("nativeRunnerPreflight") is not (len(native_files) > 0)
            or (lane["group"] != "general-server" and native_files)
        ):
            raise TrainError("test plan native Runner preflight contract is invalid")
        for path in native_files:
            safe_relative_path(path)
    if (
        type(plan.get("serverInventoryCount")) is not int or plan["serverInventoryCount"] < 1
        or type(plan.get("serializedInventoryCount")) is not int or plan["serializedInventoryCount"] < 0
    ):
        raise TrainError("test plan lane set or inventory metadata is invalid")
    projects = plan.get("workspaceProjects")
    if not isinstance(projects, dict) or set(projects) != {"general-workspaces-a", "general-workspaces-b", "general-workspaces-c"}:
        raise TrainError("test plan workspace-group contract is incomplete or unknown")
    seen_projects: set[str] = set()
    for group in ("general-workspaces-a", "general-workspaces-b", "general-workspaces-c"):
        members = _unique_string_list(projects[group], f"{group} projects")
        if not members or seen_projects.intersection(members):
            raise TrainError("test plan workspace groups are empty or overlap")
        seen_projects.update(members)
    return plan


def run_test_lane(workspace: Path, output: Path, lane_id: str) -> dict[str, Any]:
    provenance, _ = load_provenance(workspace, output)
    plan = load_test_plan(output / "test-plan.json", provenance)
    lane = next((item for item in plan["lanes"] if item["id"] == lane_id), None)
    if lane is None:
        raise TrainError(f"unknown test lane: {lane_id}")
    head_before = git(workspace, "rev-parse", "HEAD").stdout.decode().strip()
    run_checked(["pnpm", "install", "--frozen-lockfile"], workspace)
    if lane["nativeRunnerPreflight"]:
        runner_package = workspace / "packages" / "paperclip-runner"
        run_checked(["pnpm", "run", "build:rust"], runner_package)
        run_checked([
            "cargo", "build", "--release", "--manifest-path", "runner/Cargo.toml", "--locked",
            "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd", "--bin", "fake-codex-app-server",
        ], runner_package)
        run_checked(["node", "scripts/stage-runner-binary.mjs"], runner_package)
    if lane["mode"] == "general":
        command = ["pnpm", "run", "test:run:general", "--", "--group", lane["group"]]
        if lane["shardCount"] > 1:
            command += ["--shard-index", str(lane["shardIndex"]), "--shard-count", str(lane["shardCount"])]
    else:
        command = ["pnpm", "run", "test:run:serialized", "--", "--shard-index", str(lane["shardIndex"]), "--shard-count", str(lane["shardCount"])]
    run_checked(command, workspace)
    if git(workspace, "rev-parse", "HEAD").stdout.decode().strip() != head_before or git(workspace, "status", "--porcelain").stdout:
        raise TrainError("test lane changed the prepared source worktree")
    receipt = {
        "schemaVersion": 1,
        "sourceCommit": provenance["sourceCommit"],
        "patchCommit": provenance["patchCommit"],
        "patchTree": provenance["patchTree"],
        "planDigest": sha256(canonical_json(plan)),
        "lane": lane,
        "frozenInstall": True,
        "runnerBinariesPrebuilt": lane["nativeRunnerPreflight"],
        "passed": True,
    }
    write_json(output / f"test-{lane_id}.json", receipt)
    return receipt


def validate_patch_runtime_paths(workspace: Path, release_packages: list[dict[str, Any]], changed: list[str]) -> None:
    closure = production_package_closure(workspace, release_packages)
    for item in release_packages:
        if item.get("publishFromCi") is not True or item.get("name") in closure or item.get("name") == "@paperclipai/ui":
            continue
        relative = item.get("dir")
        if isinstance(relative, str) and any(path == relative or path.startswith(relative.rstrip("/") + "/") for path in changed):
            raise TrainError(f"pinned patch changes runtime source outside the installed production package closure: {item['name']}")


def validate_test_receipts(directory: Path, provenance: dict[str, Any], plan_path: Path | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    plan = load_test_plan(plan_path or directory / "test-plan.json", provenance)
    digest = sha256(canonical_json(plan))
    expected_by_id = {lane["id"]: lane for lane in plan["lanes"]}
    receipts: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.glob("test-*.json")):
        if path.name == "test-plan.json":
            continue
        receipt = json.loads(path.read_text(encoding="utf-8"))
        lane = receipt.get("lane")
        lane_id = lane.get("id") if isinstance(lane, dict) else None
        if not isinstance(lane_id, str) or lane_id not in expected_by_id:
            raise TrainError(f"unexpected test receipt or lane: {path.name}")
        if lane_id in receipts or path.name != f"test-{lane_id}.json":
            raise TrainError(f"duplicate or misnamed test receipt: {path.name}")
        if (
            receipt.get("schemaVersion") != 1
            or receipt.get("sourceCommit") != provenance["sourceCommit"]
            or receipt.get("patchCommit") != provenance["patchCommit"]
            or receipt.get("patchTree") != provenance["patchTree"]
            or receipt.get("planDigest") != digest
            or lane != expected_by_id[lane_id]
            or receipt.get("frozenInstall") is not True
            or receipt.get("runnerBinariesPrebuilt") is not expected_by_id[lane_id].get("nativeRunnerPreflight")
            or receipt.get("passed") is not True
        ):
            raise TrainError(f"test receipt does not prove its exact lane and source: {path.name}")
        receipts[lane_id] = receipt
    if set(receipts) != set(expected_by_id):
        missing = sorted(set(expected_by_id) - set(receipts))
        raise TrainError("test receipts are incomplete; missing: " + ", ".join(missing))
    return plan, [receipts[lane["id"]] for lane in plan["lanes"]]


def _copy_generated_tree(source: Path, destination: Path, root: Path) -> None:
    if source.is_symlink() or not source.is_dir() or not source.resolve().is_relative_to(root.resolve()):
        raise TrainError(f"unsafe Runner release output: {source}")
    for item in source.rglob("*"):
        if item.is_symlink():
            raise TrainError(f"Runner release output contains a symlink: {item}")
    if destination.is_symlink() or not destination.resolve().is_relative_to(root.resolve()):
        raise TrainError(f"unsafe Runner vendor destination: {destination}")
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination)


def validate_runner_artifact_inputs(artifact_root: Path, provider_pack: Path, source_commit: str) -> dict[str, Any]:
    artifact_root, provider_pack = Path(artifact_root), Path(provider_pack)
    if artifact_root.is_symlink() or provider_pack.is_symlink():
        raise TrainError("native Runner artifact paths must not be symlinks")
    try:
        artifact_root = artifact_root.resolve(strict=True)
        provider_pack = provider_pack.resolve(strict=True)
    except OSError as exc:
        raise TrainError("native Runner artifact or provider pack is missing") from exc
    if not artifact_root.is_dir() or not provider_pack.is_file():
        raise TrainError("native Runner artifact root or provider pack is missing")
    if sorted(path.name for path in artifact_root.iterdir()) != sorted(RUNNER_RELEASE_TARGETS):
        raise TrainError("native Runner artifacts must contain exactly the four release targets")
    receipts = {}
    for target in RUNNER_RELEASE_TARGETS:
        directory = artifact_root / target
        if directory.is_symlink() or not directory.is_dir() or sorted(path.name for path in directory.iterdir()) != ["paperclip-runnerd", "receipt.json"]:
            raise TrainError(f"native Runner target has an incomplete artifact/receipt pair: {target}")
        binary_path, receipt_path = directory / "paperclip-runnerd", directory / "receipt.json"
        if binary_path.is_symlink() or receipt_path.is_symlink() or not binary_path.is_file() or not receipt_path.is_file():
            raise TrainError(f"native Runner target contains unsafe files: {target}")
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise TrainError(f"native Runner receipt is invalid: {target}") from exc
        if (
            not isinstance(receipt, dict)
            or receipt.get("sourceRevision") != source_commit
            or receipt.get("target") != target
            or receipt.get("sha256") != "sha256:" + sha256(binary_path.read_bytes())
            or not isinstance(receipt.get("buildMetadata"), dict)
        ):
            raise TrainError(f"native Runner receipt does not prove the exact patched source and daemon: {target}")
        receipts[target] = receipt
    try:
        identity = json.loads(provider_pack.read_text(encoding="utf-8"))
        payload = identity.get("payload") if isinstance(identity, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TrainError("patched-source provider pack is invalid JSON") from exc
    if not isinstance(payload, dict) or payload.get("runnerSourceRevision") != source_commit:
        raise TrainError("provider pack is not bound to the exact patched source")
    return {"artifactRoot": artifact_root, "providerPack": provider_pack, "receipts": receipts}


def assemble_runner_artifacts(workspace: Path, artifact_root: Path, provider_pack: Path, source_commit: str) -> dict[str, Any]:
    """Use upstream's assembler and verifier to stage patched-source native assets."""
    if not HEX40.fullmatch(source_commit):
        raise TrainError("native Runner assets require an exact patched source commit")
    inputs = validate_runner_artifact_inputs(artifact_root, provider_pack, source_commit)
    artifact_root, provider_pack = inputs["artifactRoot"], inputs["providerPack"]
    package_root = workspace / "packages/paperclip-runner"
    pack_destination = package_root / "dist/remote-provider-packs/linux-x64/provider-pack.json"
    if pack_destination.is_symlink() or not pack_destination.resolve().is_relative_to(workspace.resolve()):
        raise TrainError("provider-pack output path escapes the prepared source")
    pack_destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(provider_pack, pack_destination)
    assembler = package_root / "scripts/stage-release-runner-binaries.mjs"
    if not assembler.is_file():
        raise TrainError("upstream Runner release assembler is missing")
    run_checked(["node", str(assembler), "assemble-daemons", str(artifact_root), source_commit], workspace)

    release_path = package_root / "dist/bin/release-manifest.json"
    try:
        release = json.loads(release_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TrainError("upstream Runner assembler did not produce a valid release manifest") from exc
    if release.get("sourceRevision") != source_commit or set(release.get("platforms", {})) != set(RUNNER_RELEASE_TARGETS):
        raise TrainError("upstream Runner release manifest does not bind all targets to the patched source")
    pack_meta = release.get("remoteProviderPack")
    if not isinstance(pack_meta, dict) or pack_meta.get("sourceRevision") != source_commit or pack_meta.get("target") != "linux-x64":
        raise TrainError("upstream Runner release manifest does not bind the provider pack to the patched source")

    vendor = workspace / "server/dist/vendor/paperclip-runner"
    _copy_generated_tree(package_root / "dist/bin", vendor / "bin", workspace)
    _copy_generated_tree(package_root / "dist/remote-provider-packs", vendor / "remote-provider-packs", workspace)
    targets = {}
    for target in RUNNER_RELEASE_TARGETS:
        entry = release["platforms"][target]
        expected_path = f"{target}/paperclip-runnerd"
        if entry.get("path") != expected_path or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(entry.get("sha256", ""))):
            raise TrainError(f"upstream assembler emitted invalid target metadata for {target}")
        binary = package_root / "dist/bin" / entry["path"]
        if not binary.is_file() or binary.is_symlink() or "sha256:" + sha256(binary.read_bytes()) != entry["sha256"]:
            raise TrainError(f"upstream assembler omitted the {target} daemon")
        receipt = inputs["receipts"][target]
        targets[target] = {
            "path": entry["path"],
            "sha256": entry["sha256"],
            "receiptSha256": sha256((artifact_root / target / "receipt.json").read_bytes()),
            "buildMetadata": receipt["buildMetadata"],
        }
    pack = package_root / "dist/remote-provider-packs/linux-x64/provider-pack.json"
    if not pack.is_file() or pack.is_symlink():
        raise TrainError("upstream Runner assembler omitted the source-matched provider pack")
    return {
        "sourceRevision": source_commit,
        "targets": targets,
        "releaseManifestSha256": sha256(release_path.read_bytes()),
        "providerPack": {"path": "remote-provider-packs/linux-x64/provider-pack.json", "sha256": sha256(pack.read_bytes()), "target": "linux-x64"},
    }


def build(
    workspace: Path,
    output: Path,
    test_receipts: Path | None = None,
    runner_artifacts: Path | None = None,
    provider_pack: Path | None = None,
) -> dict[str, Any]:
    provenance, release_packages = load_provenance(workspace, output)
    test_evidence = None
    if test_receipts is not None:
        _, test_evidence = validate_test_receipts(test_receipts, provenance, output / "test-plan.json")
    if (runner_artifacts is None) != (provider_pack is None):
        raise TrainError("native Runner artifacts and provider pack must be supplied together")
    if runner_artifacts is None or provider_pack is None:
        raise TrainError("complete native Runner artifact receipts and patched-source provider pack are required")
    validate_runner_artifact_inputs(runner_artifacts, provider_pack, provenance["patchCommit"])
    commands = [
        ["pnpm", "install", "--frozen-lockfile"],
        ["pnpm", "-r", "typecheck"],
        ["pnpm", "build"],
        ["node", "scripts/build-standalone-public-packages.mjs"],
        ["bash", "scripts/prepare-server-ui-dist.sh"],
    ]
    if test_receipts is None:
        commands.insert(2, ["pnpm", "test:run"])
    for command in commands:
        run_checked(command, workspace)
    status = git(workspace, "status", "--porcelain").stdout
    if status:
        paths = status.decode("utf-8", "replace").strip()[:4000]
        raise TrainError("release build left source changes; refusing to package dirty worktree: " + paths)
    native_evidence = assemble_runner_artifacts(workspace, runner_artifacts, provider_pack, provenance["patchCommit"])
    runtime_trees = {
        name: sha256(canonical_json(hash_tree(path)))
        for name, path in sorted(runtime_directories(workspace, release_packages).items())
    }
    result = {
        "schemaVersion": 1,
        "version": provenance["version"],
        "sourceCommit": provenance["sourceCommit"],
        "patchCommit": provenance["patchCommit"],
        "patchTree": provenance["patchTree"],
        "quality": {"frozenInstall": True, "typecheck": True, "tests": True, "build": True, "standalonePackages": True, "serverUi": True, "nativeRunnerArtifacts": True},
        "runtimeTrees": runtime_trees,
        "nativeRunnerEvidence": native_evidence,
    }
    if test_evidence is not None:
        result["testEvidence"] = test_evidence
    write_json(output / "build.json", result)
    return result


def hash_tree(directory: Path) -> dict[str, str]:
    directory = Path(directory)
    if directory.is_symlink():
        raise TrainError(f"runtime output contains a symlink: {directory}")
    if directory.is_file():
        return {"": sha256(directory.read_bytes())}
    if not directory.is_dir():
        raise TrainError(f"runtime output path is missing: {directory}")
    result = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            result[path.relative_to(directory).as_posix()] = "symlink:" + os.readlink(path)
        elif path.is_file():
            result[path.relative_to(directory).as_posix()] = sha256(path.read_bytes())
    return result


def archive_root(key: str) -> PurePosixPath:
    package_name, relative = key.split("#", 1)
    return PurePosixPath("node_modules") / PurePosixPath(package_name) / safe_relative_path(relative)


def production_package_closure(workspace: Path, release_manifest: list[dict[str, Any]]) -> set[str]:
    """Find public workspace packages installed transitively by CLI or server."""
    packages = {
        item["name"]: item
        for item in release_manifest
        if item.get("publishFromCi") is True and isinstance(item.get("name"), str)
    }
    pending = list(DEFAULT_PACKAGES)
    closure: set[str] = set()
    while pending:
        name = pending.pop()
        if name in closure:
            continue
        item = packages.get(name)
        if item is None:
            raise TrainError(f"required production package is not published by CI: {name}")
        closure.add(name)
        source = (workspace / item["dir"]).resolve()
        if not source.is_relative_to(workspace.resolve()):
            raise TrainError(f"package directory escapes workspace: {item['dir']}")
        package = json.loads((source / "package.json").read_text(encoding="utf-8"))
        if package.get("name") != name:
            raise TrainError(f"release package identity does not match its directory: {name}")
        for field in ("dependencies", "optionalDependencies"):
            dependencies = package.get(field, {})
            if not isinstance(dependencies, dict):
                raise TrainError(f"{name} has an invalid {field} table")
            for dependency in dependencies:
                if dependency in packages and dependency not in closure:
                    pending.append(dependency)
    return closure


def runtime_directories(workspace: Path, release_manifest: list[dict[str, Any]]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    closure = production_package_closure(workspace, release_manifest)
    for item in release_manifest:
        if item.get("publishFromCi") is not True or item.get("name") not in closure:
            continue
        name, relative = item.get("name"), item.get("dir")
        if not isinstance(name, str) or not PACKAGE_NAME.fullmatch(name) or not isinstance(relative, str):
            raise TrainError("invalid entry in scripts/release-package-manifest.json")
        source = (workspace / relative).resolve()
        if not source.is_relative_to(workspace.resolve()):
            raise TrainError(f"package directory escapes workspace: {relative}")
        if name == "@paperclipai/ui":
            # Its built browser assets are copied into @paperclipai/server/ui-dist.
            continue
        package = json.loads((source / "package.json").read_text(encoding="utf-8"))
        if package.get("name") != name:
            raise TrainError(f"release package identity does not match its directory: {name}")
        entries = package.get("files")
        if not isinstance(entries, list):
            raise TrainError(f"{name} has no explicit npm files allowlist")
        for raw_entry in entries:
            if not isinstance(raw_entry, str):
                raise TrainError(f"{name} has an invalid npm files entry")
            entry = raw_entry.rstrip("/")
            path = safe_relative_path(entry)
            if path.name.lower() in {"readme.md", "license", "licence"}:
                continue
            if any(part == "package.json" for part in path.parts) or "*" in entry:
                raise TrainError(f"{name} has an unsupported npm files entry: {raw_entry}")
            target = source / Path(*path.parts)
            if entry == "skills" and relative in RELEASE_SKILLS_PACKAGE_DIRS:
                # release.sh copies the canonical skills tree into these npm
                # packages. Read it directly at the archive boundary instead
                # of creating untracked publish staging files in the source.
                target = workspace / "skills"
            elif (entry == "skills" and relative in OPTIONAL_EMPTY_SKILLS_PACKAGE_DIRS
                  and not target.exists() and not target.is_symlink()):
                # The layout exception must not hide a patched deletion from
                # a future Canary which actually ships adapter-specific skills.
                marker = json.loads((workspace / ".canary-train.json").read_text(encoding="utf-8"))
                original_commit = marker.get("sourceCommit")
                if not isinstance(original_commit, str) or not HEX40.fullmatch(original_commit):
                    raise TrainError("optional skills require a pinned published source commit")
                if git(workspace, "ls-tree", original_commit, "--", f"{relative}/skills").stdout:
                    raise TrainError(f"{name} declared skills were removed from published source")
                # npm's files list permits absent paths. Other adapters declare
                # skills but release.sh does not stage the canonical tree for
                # them. Preserve their published layout; do not synthesize skills
                # or relax the required compiled runtime output checks.
                continue
            if target.is_dir() or target.is_file():
                result[f"{name}#{path.as_posix()}"] = target
            else:
                raise TrainError(f"{name} declared npm runtime output that was not built: {entry}")
    for required in DEFAULT_PACKAGES:
        if f"{required}#dist" not in result:
            raise TrainError(f"runtime dist output missing for {required}")
    return result


MIGRATION_COMPAT_ASSERTIONS = (
    "migration-engine-upgrade",
    "task-retry-row-preserved",
    "candidate-schema-current",
    "migration-specific-invariants",
    "secret-scope-data-preserved",
    "restore-point-checkout-migrations",
    "committed-native-recovery-state-migration",
    "settled-native-run-process-identity-migration",
    "migration-inventory-extension",
)
MIGRATION_INVENTORY_PREFIX = "node_modules/@paperclipai/db/dist/migrations/"
MIGRATION_OLD_VERSION = "2026.1017.0-canary.6"
MIGRATION_OLD_SRI = "sha512-ben+ng50+SxXKmXD8MCUit6yZf20i0CQBWG6ZZq44AGvnX8GF5OvLH/F9ogzXFAgEW/Kc2LXCf3qvPolcoagCg=="
MIGRATION_BASELINE_HASH = "9cec6945b6dd1c38b80940e5246d500da8b5d506a4be68db20ab89136fc11ed9"
MIGRATION_CANDIDATE_HASH = "cf72a4cb66052ff1c4d93f5ec4d29a291d08a28d2355e02e089d92e3052c9e3a"


def assemble_migration_compatibility_receipt(receipt: dict[str, Any], provenance: dict[str, Any], runtime_inventory: dict[str, str], *, run_id: int, run_attempt: int, controller_commit: str) -> dict[str, Any]:
    body = {key: value for key, value in receipt.items() if key != "receiptSha256"}
    expected_receipt_hash = hashlib.sha256(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    prepared = receipt.get("preparedSource")
    old_package = receipt.get("oldPackage")
    candidate = receipt.get("candidate")
    candidate_package = provenance.get("npmPackages", {}).get("@paperclipai/db")
    assertions = receipt.get("assertions")
    if receipt.get("schema") != 1 or receipt.get("receiptSha256") != expected_receipt_hash:
        raise TrainError("migration compatibility evidence has an invalid receipt digest")
    if not isinstance(prepared, dict) or not isinstance(old_package, dict) or not isinstance(candidate, dict):
        raise TrainError("migration compatibility evidence is incomplete")
    if (
        receipt.get("candidateSourceCommit") != provenance.get("sourceCommit")
        or prepared.get("sourceCommit") != provenance.get("sourceCommit")
        or prepared.get("patchCommit") != provenance.get("patchCommit")
        or prepared.get("patchTree") != provenance.get("patchTree")
        or not isinstance(candidate_package, dict)
        or not re.fullmatch(r"\d{4}\.\d+\.0-canary\.\d+", str(provenance.get("version", "")))
        or candidate_package.get("version") != provenance.get("version")
        or candidate.get("version") != provenance.get("version")
        or candidate.get("integrity") != candidate_package.get("integrity")
        or not re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", str(candidate_package.get("integrity", "")))
        or candidate.get("migrationInventoryCount") != 377
        or candidate.get("migrationInventorySha256") != MIGRATION_CANDIDATE_HASH
        or prepared.get("migrationInventoryCount") != 377
        or prepared.get("migrationInventorySha256") != MIGRATION_CANDIDATE_HASH
        or old_package.get("version") != MIGRATION_OLD_VERSION
        or old_package.get("integrity") != MIGRATION_OLD_SRI
        or old_package.get("migrationInventoryCount") != 354
        or old_package.get("migrationInventorySha256") != MIGRATION_BASELINE_HASH
    ):
        raise TrainError("migration compatibility evidence does not match the prepared source and reviewed package transition")
    if not isinstance(assertions, list) or len(assertions) != len(MIGRATION_COMPAT_ASSERTIONS):
        raise TrainError("migration compatibility evidence is missing required assertions")
    assertion_ids = [item.get("id") for item in assertions if isinstance(item, dict) and item.get("passed") is True]
    if len(assertion_ids) != len(MIGRATION_COMPAT_ASSERTIONS) or len(set(assertion_ids)) != len(assertion_ids) or set(assertion_ids) != set(MIGRATION_COMPAT_ASSERTIONS):
        raise TrainError("migration compatibility evidence contains failed, missing, or duplicate assertions")
    # Inventory receipts hash compact sorted JSON bytes without a trailing LF.
    # canonical_json() is the on-disk receipt codec and deliberately adds one.
    actual_hash = sha256(json.dumps(runtime_inventory, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    if len(runtime_inventory) != 377 or actual_hash != MIGRATION_CANDIDATE_HASH or actual_hash != candidate.get("migrationInventorySha256"):
        raise TrainError("compiled runtime migration inventory differs from the tested candidate")
    if not re.fullmatch(r"[a-f0-9]{40}", controller_commit) or run_id <= 0 or run_attempt <= 0:
        raise TrainError("migration compatibility evidence requires a valid workflow identity")
    return {
        "schemaVersion": 1,
        "baselineInventorySha256": old_package["migrationInventorySha256"],
        "candidateInventorySha256": actual_hash,
        "baselinePackage": {"version": old_package["version"], "integrity": old_package["integrity"]},
        "candidatePackage": {"version": candidate["version"], "integrity": candidate["integrity"]},
        "baselineFileCount": old_package["migrationInventoryCount"],
        "candidateFileCount": len(runtime_inventory),
        "upgradeProof": {
            "passed": True,
            "runId": run_id,
            "runAttempt": run_attempt,
            "controllerCommit": controller_commit,
            "sourceCommit": provenance["sourceCommit"],
            "patchCommit": provenance["patchCommit"],
            "assertions": assertion_ids,
        },
    }


def package(workspace: Path, output: Path, migration_receipt_path: Path | None = None) -> dict[str, Any]:
    provenance, release_manifest = load_provenance(workspace, output)
    build_path = output / "build.json"
    if not build_path.is_file():
        raise TrainError("build.json missing; run build and pass its quality gates")
    build_result = json.loads(build_path.read_text(encoding="utf-8"))
    required_gates = {"frozenInstall", "typecheck", "tests", "build", "standalonePackages", "serverUi", "nativeRunnerArtifacts"}
    quality = build_result.get("quality")
    if (
        build_result.get("version") != provenance["version"]
        or build_result.get("sourceCommit") != provenance["sourceCommit"]
        or build_result.get("patchCommit") != provenance["patchCommit"]
        or not isinstance(quality, dict)
        or any(quality.get(name) is not True for name in required_gates)
    ):
        raise TrainError("build result does not prove every gate for this exact patch commit")
    current_runtime_trees = {
        name: sha256(canonical_json(hash_tree(path)))
        for name, path in sorted(runtime_directories(workspace, release_manifest).items())
    }
    if current_runtime_trees != build_result.get("runtimeTrees"):
        raise TrainError("runtime build output changed after the successful build receipt")
    stamp = json.loads((workspace / "server/dist/build-info.json").read_text(encoding="utf-8"))
    if str(stamp.get("commit", "")).lower() != provenance["patchCommit"]:
        raise TrainError("server build stamp does not match the pinned patch commit")
    output.mkdir(parents=True, exist_ok=True)
    payload = output / "payload.tar.gz"
    files: dict[str, str] = {}
    package_map = {}
    import io
    with payload.open("wb") as raw_payload:
        with gzip.GzipFile(fileobj=raw_payload, mode="wb", filename="", mtime=0) as gzip_payload:
            with tarfile.open(fileobj=gzip_payload, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for key, directory in sorted(runtime_directories(workspace, release_manifest).items()):
                    root = archive_root(key)
                    package_map[key] = root.as_posix()
                    sources = [directory] if directory.is_file() else sorted(directory.rglob("*"))
                    for source in sources:
                        if source.is_symlink():
                            raise TrainError(f"runtime output contains a symlink: {source}")
                        if not source.is_file():
                            continue
                        rel = "" if directory.is_file() else source.relative_to(directory).as_posix()
                        dest = root.as_posix() if not rel else (root / safe_relative_path(rel)).as_posix()
                        safe_relative_path(dest)
                        data = source.read_bytes()
                        info = tarfile.TarInfo(dest)
                        info.size = len(data)
                        info.mode = 0o755 if os.access(source, os.X_OK) else 0o644
                        info.mtime = 0
                        archive.addfile(info, io.BytesIO(data))
                        files[dest] = sha256(data)
    if not files:
        raise TrainError("runtime overlay contains no files")
    migration_root = workspace / "packages/db/dist/migrations"
    if not migration_root.is_dir():
        raise TrainError("compiled database migrations are missing from the packaged @paperclipai/db runtime")
    migrations = []
    for path in sorted(migration_root.rglob("*")):
        if path.is_symlink():
            raise TrainError(f"database migration output contains a symlink: {path}")
        if path.is_file() and path.suffix in {".sql", ".json"}:
            installed = "node_modules/@paperclipai/db/" + path.relative_to(workspace / "packages/db").as_posix()
            migrations.append({"path": installed, "sha256": sha256(path.read_bytes())})
    if not migrations:
        raise TrainError("compiled database migration inventory is empty")
    migration_compatibility = None
    if migration_receipt_path is not None:
        runtime_inventory = {
            item["path"]: item["sha256"]
            for item in migrations
            if item["path"].endswith(".sql") or item["path"].endswith("/meta/_journal.json")
        }
        try:
            receipt = json.loads(migration_receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise TrainError("migration compatibility receipt is missing or invalid") from exc
        try:
            migration_compatibility = assemble_migration_compatibility_receipt(
                receipt,
                provenance,
                runtime_inventory,
                run_id=int(os.environ["GITHUB_RUN_ID"]),
                run_attempt=int(os.environ["GITHUB_RUN_ATTEMPT"]),
                controller_commit=os.environ["GITHUB_SHA"].lower(),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainError("migration compatibility receipt workflow identity is invalid") from exc
    manifest = {
        "schemaVersion": 1,
        "version": provenance["version"],
        "sourceCommit": provenance["sourceCommit"],
        "sourceTree": provenance["sourceTree"],
        "patchCommit": provenance["patchCommit"],
        "patchedCommit": provenance["patchCommit"],
        "patchTree": provenance["patchTree"],
        "branch": provenance["branch"],
        "patches": provenance["patches"],
        "npmPackages": provenance["npmPackages"],
        "packageMap": package_map,
        "files": files,
        "migrations": migrations,
        "quality": quality,
        "archiveSha256": sha256(payload.read_bytes()),
    }
    if migration_compatibility is not None:
        manifest["migrationCompatibilityReceipt"] = migration_compatibility
    if "testEvidence" in build_result:
        manifest["testEvidence"] = build_result["testEvidence"]
    native_evidence = build_result.get("nativeRunnerEvidence")
    if (
        not isinstance(native_evidence, dict)
        or native_evidence.get("sourceRevision") != provenance["patchCommit"]
        or set(native_evidence.get("targets", {})) != set(RUNNER_RELEASE_TARGETS)
        or not isinstance(native_evidence.get("providerPack"), dict)
    ):
        raise TrainError("build receipt is missing complete source-bound native Runner evidence")
    release_path = workspace / "server/dist/vendor/paperclip-runner/bin/release-manifest.json"
    try:
        release = json.loads(release_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TrainError("server runtime is missing the assembled Runner release manifest") from exc
    if release.get("sourceRevision") != provenance["patchCommit"] or set(release.get("platforms", {})) != set(RUNNER_RELEASE_TARGETS):
        raise TrainError("server runtime Runner manifest does not match the patched source")
    for target in RUNNER_RELEASE_TARGETS:
        evidence = native_evidence["targets"].get(target)
        entry = release["platforms"].get(target)
        if (
            not isinstance(evidence, dict)
            or not isinstance(entry, dict)
            or evidence.get("path") != entry.get("path")
            or evidence.get("sha256") != entry.get("sha256")
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(evidence.get("sha256", "")))
            or not re.fullmatch(r"[a-f0-9]{64}", str(evidence.get("receiptSha256", "")))
            or not isinstance(evidence.get("buildMetadata"), dict)
        ):
            raise TrainError(f"native Runner receipt evidence is incomplete for {target}")
    provider_evidence = native_evidence["providerPack"]
    provider_path = workspace / "server/dist/vendor/paperclip-runner/remote-provider-packs/linux-x64/provider-pack.json"
    release_pack = release.get("remoteProviderPack")
    if (
        provider_evidence.get("path") != "remote-provider-packs/linux-x64/provider-pack.json"
        or provider_evidence.get("target") != "linux-x64"
        or provider_evidence.get("sha256") != sha256(provider_path.read_bytes())
        or not isinstance(release_pack, dict)
        or release_pack.get("sourceRevision") != provenance["patchCommit"]
        or release_pack.get("target") != "linux-x64"
    ):
        raise TrainError("provider pack evidence is missing or does not match the patched runtime")
    manifest["nativeRunnerEvidence"] = native_evidence
    write_json(output / "manifest.json", manifest)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "plan", "test", "build", "package"):
        command = commands.add_parser(name)
        command.add_argument("--workspace", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
        if name == "prepare":
            command.add_argument("--manifest", type=Path, required=True)
            command.add_argument("--canary-version")
        elif name == "test":
            command.add_argument("--lane", required=True)
        elif name == "build":
            command.add_argument("--test-receipts", type=Path)
            command.add_argument("--runner-artifacts", type=Path, required=True)
            command.add_argument("--provider-pack", type=Path, required=True)
        elif name == "package":
            command.add_argument("--migration-receipt", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        workspace, output = args.workspace.resolve(), args.output.resolve()
        if args.command == "prepare":
            manifest = validate_manifest(json.loads(args.manifest.read_text(encoding="utf-8")))
            result = prepare(workspace, output, manifest, args.manifest, args.canary_version)
        elif args.command == "plan":
            result = create_test_plan(workspace, output)
        elif args.command == "test":
            result = run_test_lane(workspace, output, args.lane)
        elif args.command == "build":
            result = build(
                workspace,
                output,
                args.test_receipts.resolve() if args.test_receipts else None,
                args.runner_artifacts.resolve(),
                args.provider_pack.resolve(),
            )
        else:
            result = package(workspace, output, args.migration_receipt.resolve())
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except (TrainError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(f"canary patch train failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
