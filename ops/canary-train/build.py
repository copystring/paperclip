#!/usr/bin/env python3
"""Resolve, patch, build, and package an integrity-indexed Paperclip canary overlay."""
from __future__ import annotations

import argparse
import base64
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
DEFAULT_PACKAGES = ("paperclipai", "@paperclipai/server")
REGISTRY = "https://registry.npmjs.org"
GITHUB_API = "https://api.github.com"
PATCH_BRANCH = "deploy/canary-patched"
DEPENDENCY_FILES = {
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json",
    "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", ".npmrc",
}


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


def resolve_canary() -> tuple[str, dict[str, dict[str, Any]], str]:
    docs: dict[str, dict[str, Any]] = {}
    versions = {}
    for name in DEFAULT_PACKAGES:
        tags = http_json(npm_url(name, "dist-tags"))
        version = tags.get("canary")
        if not isinstance(version, str) or not version:
            raise TrainError(f"npm canary tag is missing for {name}")
        doc = http_json(npm_url(name, urllib.parse.quote(version, safe="")))
        if doc.get("name") != name or doc.get("version") != version or not isinstance(doc.get("dist", {}).get("tarball"), str):
            raise TrainError(f"npm metadata identity mismatch for {name}@{version}")
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
    return version, docs, source_commit


def git(cwd: Path, *args: str, input_bytes: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(["git", *args], cwd=cwd, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise TrainError(f"git {' '.join(args[:4])} failed: {detail}")
    return result


def is_ancestor(cwd: Path, ancestor: str, commit: str) -> bool:
    return git(cwd, "merge-base", "--is-ancestor", ancestor, commit, check=False).returncode == 0


def prepare(workspace: Path, output: Path, manifest: dict[str, Any], manifest_path: Path | None = None) -> dict[str, Any]:
    version, npm_docs, source_commit = resolve_canary()
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
            } for name in DEFAULT_PACKAGES
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


def validate_patch_runtime_paths(workspace: Path, release_packages: list[dict[str, Any]], changed: list[str]) -> None:
    closure = production_package_closure(workspace, release_packages)
    for item in release_packages:
        if item.get("publishFromCi") is not True or item.get("name") in closure or item.get("name") == "@paperclipai/ui":
            continue
        relative = item.get("dir")
        if isinstance(relative, str) and any(path == relative or path.startswith(relative.rstrip("/") + "/") for path in changed):
            raise TrainError(f"pinned patch changes runtime source outside the installed production package closure: {item['name']}")


def build(workspace: Path, output: Path) -> dict[str, Any]:
    provenance, release_packages = load_provenance(workspace, output)
    commands = [
        ["pnpm", "install", "--frozen-lockfile"],
        ["pnpm", "-r", "typecheck"],
        ["pnpm", "test:run"],
        ["pnpm", "build"],
        ["node", "scripts/build-standalone-public-packages.mjs"],
        ["bash", "scripts/prepare-server-ui-dist.sh"],
    ]
    for command in commands:
        print("+ " + " ".join(command), flush=True)
        clean_env = os.environ.copy()
        clean_env.pop("GH_TOKEN", None)
        clean_env.pop("GITHUB_TOKEN", None)
        subprocess.run(command, cwd=workspace, check=True, env=clean_env)
    for package_dir in ("server", "packages/adapters/claude-local", "packages/adapters/codex-local"):
        source, destination = workspace / "skills", workspace / package_dir / "skills"
        if destination.exists():
            if hash_tree(destination) != hash_tree(source):
                raise TrainError(f"refusing to replace non-identical generated skills directory: {destination}")
        else:
            shutil.copytree(source, destination)
    if git(workspace, "status", "--porcelain").stdout:
        raise TrainError("release build left source changes; refusing to package dirty worktree")
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
        "quality": {"frozenInstall": True, "typecheck": True, "tests": True, "build": True, "standalonePackages": True, "serverUi": True},
        "runtimeTrees": runtime_trees,
    }
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
            if target.is_dir() or target.is_file():
                result[f"{name}#{path.as_posix()}"] = target
            else:
                raise TrainError(f"{name} declared npm runtime output that was not built: {entry}")
    for required in DEFAULT_PACKAGES:
        if f"{required}#dist" not in result:
            raise TrainError(f"runtime dist output missing for {required}")
    return result


def package(workspace: Path, output: Path) -> dict[str, Any]:
    provenance, release_manifest = load_provenance(workspace, output)
    build_path = output / "build.json"
    if not build_path.is_file():
        raise TrainError("build.json missing; run build and pass its quality gates")
    build_result = json.loads(build_path.read_text(encoding="utf-8"))
    required_gates = {"frozenInstall", "typecheck", "tests", "build", "standalonePackages", "serverUi"}
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
    write_json(output / "manifest.json", manifest)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "build", "package"):
        command = commands.add_parser(name)
        command.add_argument("--workspace", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
        if name == "prepare":
            command.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        workspace, output = args.workspace.resolve(), args.output.resolve()
        if args.command == "prepare":
            manifest = validate_manifest(json.loads(args.manifest.read_text(encoding="utf-8")))
            result = prepare(workspace, output, manifest, args.manifest)
        elif args.command == "build":
            result = build(workspace, output)
        else:
            result = package(workspace, output)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except (TrainError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(f"canary patch train failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
