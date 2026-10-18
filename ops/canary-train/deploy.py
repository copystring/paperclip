#!/usr/bin/env python3
"""Stage and activate a verified Paperclip patched-Canary release.

This process intentionally has no GitHub write path. It accepts only public,
successful workflow releases from the configured fork and verifies every
download before touching the installed package.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class DeployError(RuntimeError):
    """A fail-closed deployment check failed."""


HEX_64 = re.compile(r"^[0-9a-f]{64}$")
HEX_40 = re.compile(r"^[0-9a-f]{40}$")
VERSION = re.compile(r"^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
ASSET_NAMES = {"manifest.json", "payload.tar.gz"}
MIGRATION_ROOT = "node_modules/@paperclipai/db/dist/migrations/"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _json_bytes(data: bytes, label: str):
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DeployError(f"{label} is not valid JSON") from exc


def _safe_relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise DeployError("Release contains an invalid path")
    path = PurePosixPath(value)
    if path.is_absolute() or re.match(r"^[A-Za-z]:", path.parts[0]) or any(part in ("", ".", "..") for part in path.parts):
        raise DeployError("Release path escapes the candidate")
    if path.as_posix() != value:
        raise DeployError("Release path is not canonical")
    return path


def _file_inventory(root: Path, relative_root: str | None = None) -> dict[str, str]:
    root = Path(root)
    base = root / relative_root if relative_root else root
    if not base.is_dir():
        raise DeployError(f"Required directory is missing: {relative_root or root.name}")
    files: dict[str, str] = {}
    for path in sorted(base.rglob("*")):
        if path.is_symlink():
            raise DeployError("Symlink in migration inventory")
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            files[rel] = hash_file(path)
    return files


def verify_manifest(manifest: dict, expected_repository: str, expected_workflow: str, expected_patches=None):
    if manifest.get("schemaVersion") != 1:
        raise DeployError("Unsupported release manifest schema")
    version = manifest.get("version")
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise DeployError("Manifest version is invalid")
    for field in ("sourceCommit", "patchedCommit", "controllerCommit"):
        if not isinstance(manifest.get(field), str) or not HEX_40.fullmatch(manifest[field]):
            raise DeployError(f"Manifest {field} is invalid")
    if not isinstance(manifest.get("runId"), (str, int)) or not str(manifest["runId"]).isdigit():
        raise DeployError("Manifest workflow run ID is invalid")
    attempt = manifest.get("runAttempt")
    if not isinstance(attempt, int) or attempt < 1:
        raise DeployError("Manifest workflow run attempt is invalid")
    workflow_ref = manifest.get("workflowRef", "")
    workflow_path = workflow_ref.split("@", 1)[0]
    if workflow_path.startswith(expected_repository + "/"):
        workflow_path = workflow_path[len(expected_repository) + 1:]
    if workflow_path != expected_workflow or "@" not in workflow_ref:
        raise DeployError("Manifest workflow reference does not match the configured workflow")
    patches = manifest.get("patches")
    if not isinstance(patches, list) or not patches or any(
        not isinstance(p, dict) or not isinstance(p.get("number"), int) or p["number"] < 1
        or not isinstance(p.get("repository"), str) or not isinstance(p.get("head"), str)
        or not HEX_40.fullmatch(p["head"]) for p in patches
    ):
        raise DeployError("Manifest patch list is missing or invalid")
    package_names = manifest.get("packageNames")
    if package_names != ["paperclipai", "@paperclipai/server"]:
        raise DeployError("Manifest npm package set is not the verified Paperclip runtime pair")
    package_map = manifest.get("packageMap")
    if not isinstance(package_map, dict) or not package_map:
        raise DeployError("Manifest package root map is missing")
    roots = []
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise DeployError("Manifest file inventory is missing")
    for key, root in package_map.items():
        if not isinstance(key, str) or not key or not isinstance(root, str):
            raise DeployError("Manifest package root entry is invalid")
        rel = _safe_relative(root)
        parts = rel.parts
        if len(parts) < 3 or parts[0] != "node_modules" or parts[-1] == "package.json":
            raise DeployError("Manifest package root is unsafe or replaces package metadata")
        if parts[1] not in {"paperclipai", "@paperclipai"}:
            raise DeployError("Manifest package root is outside approved npm packages")
        if parts[1] == "@paperclipai" and len(parts) < 4:
            raise DeployError("Manifest package root would replace an entire scoped package")
        package_name, separator, package_relative = key.partition("#")
        if not separator or not package_relative:
            raise DeployError("Manifest package root key is invalid")
        expected_root = PurePosixPath("node_modules") / package_name / _safe_relative(package_relative)
        if expected_root.as_posix() != rel.as_posix():
            raise DeployError("Package root does not match its npm package map key")
        roots.append(rel.as_posix())
    for root in roots:
        if any(other != root and other.startswith(root + "/") for other in roots):
            raise DeployError("Manifest package roots overlap")
    for name, digest in files.items():
        rel = _safe_relative(name).as_posix()
        if not any(rel == root or rel.startswith(root + "/") for root in roots):
            raise DeployError("Manifest file is outside its exact package roots")
        if not isinstance(digest, str) or not HEX_64.fullmatch(digest):
            raise DeployError("Manifest contains an invalid file digest")
    if any(not any(name == root or name.startswith(root + "/") for name in files) for root in roots):
        raise DeployError("Every replacement root must have a complete manifest file inventory")
    if any(root in files and any(name.startswith(root + "/") for name in files) for root in roots):
        raise DeployError("Package root cannot be both a single file and a directory")
    expected = manifest.get("expectedPatches")
    if expected is not None and sorted(map(_patch_identity, patches)) != sorted(map(_patch_identity, expected)):
        raise DeployError("Release patch set differs from the configured patch set")
    quality = manifest.get("quality")
    if not isinstance(quality, dict) or any(quality.get(k) is not True for k in ("typecheck", "tests", "build")):
        raise DeployError("Release is missing green typecheck, test, and build results")
    migrations = manifest.get("migrations")
    if not isinstance(migrations, list):
        raise DeployError("Manifest migration inventory is missing")
    migration_map = {}
    for item in migrations:
        if not isinstance(item, dict):
            raise DeployError("Manifest migration entry is invalid")
        name = _safe_relative(item.get("path", "")).as_posix()
        if not name.startswith(MIGRATION_ROOT) or not name.endswith((".sql", ".json")):
            raise DeployError("Manifest migration path is outside the database migration directory")
        digest = item.get("sha256")
        if not isinstance(digest, str) or not HEX_64.fullmatch(digest) or name in migration_map:
            raise DeployError("Manifest migration digest is invalid or duplicated")
        migration_map[name] = digest
    if not migration_map:
        raise DeployError("Manifest migration inventory is empty")
    for name, digest in migration_map.items():
        if files.get(name) != digest:
            raise DeployError("Manifest migration digest differs from the packaged runtime file")
    if expected_patches is not None and sorted(map(_patch_identity, patches)) != sorted(map(_patch_identity, expected_patches)):
        raise DeployError("Release patch set differs from the configured patch pins")
    return manifest


def _patch_identity(item):
    if isinstance(item, dict):
        return f"{item.get('repository')}#{item.get('number')}@{item.get('head')}"
    return str(item)


class Http:
    def __init__(self, timeout: int = 30):
        self.timeout = timeout

    def get(self, url: str, headers: dict[str, str] | None = None) -> bytes:
        request = urllib.request.Request(url, headers={"User-Agent": "paperclip-canary-deployer/1", **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            raise DeployError(f"GET failed for {urllib.parse.urlsplit(url).path}") from exc

    def request_json(self, url: str, method: str = "GET", body: dict | None = None,
                     token: str | None = None) -> dict | list:
        headers = {"Accept": "application/json"}
        data = None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                return _json_bytes(response.read(), "HTTP response")
        except (urllib.error.URLError, TimeoutError) as exc:
            raise DeployError(f"{method} failed for {urllib.parse.urlsplit(url).path}") from exc


class Deployer:
    def __init__(self, config: dict, http=None, command=subprocess.run, clock=time.time):
        self.c = config
        self.http = http or Http()
        self.command = command
        self.clock = clock
        self.repository = config.get("repository")
        if not isinstance(self.repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.repository):
            raise DeployError("Configured public GitHub repository is invalid")
        self.workflow = config.get("workflow")
        if not isinstance(self.workflow, str) or not self.workflow.startswith(".github/workflows/"):
            raise DeployError("Configured workflow path is invalid")
        self.home = Path(config.get("home", ""))
        if not self.home.is_absolute():
            raise DeployError("Configured Paperclip home must be absolute")
        self.cli_root = self.home / ".paperclip/cli"
        self.installs = self.cli_root / "installs/npm"
        self.current_link = self.cli_root / "current"
        self.install_json = self.cli_root / "install.json"
        self.api = str(config.get("apiBase", "")).rstrip("/")
        if not self.api.startswith("http://127.0.0.1:") and not self.api.startswith("http://localhost:"):
            raise DeployError("Paperclip API must use loopback HTTP")

    def github(self, path: str):
        return f"https://api.github.com/repos/{self.repository}/{path.lstrip('/')}"

    def list_releases(self):
        page = 1
        while page <= 10:
            rows = _json_bytes(self.http.get(self.github(f"releases?per_page=100&page={page}"),
                                             {"Accept": "application/vnd.github+json"}), "GitHub release list")
            if not isinstance(rows, list):
                raise DeployError("GitHub release list response is invalid")
            yield from rows
            if len(rows) < 100:
                return
            page += 1

    def verify_workflow_run(self, manifest: dict):
        run_id = str(manifest["runId"])
        run = _json_bytes(self.http.get(self.github(f"actions/runs/{run_id}"),
                                       {"Accept": "application/vnd.github+json"}), "GitHub workflow run")
        if not isinstance(run, dict):
            raise DeployError("GitHub workflow run response is invalid")
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            raise DeployError("Release workflow is not completed successfully")
        if run.get("path") != self.workflow or run.get("event") not in {"schedule", "workflow_dispatch"}:
            raise DeployError("Release was not produced by the allowed workflow event")
        if (run.get("head_repository") or {}).get("full_name", "").lower() != self.repository.lower():
            raise DeployError("Release workflow did not run in the configured public fork")
        if str(run.get("id")) != run_id:
            raise DeployError("GitHub workflow run ID does not match the release manifest")
        if run.get("head_sha") != manifest["controllerCommit"]:
            raise DeployError("Release workflow commit does not match the manifest")
        if int(run.get("run_attempt", 0)) != manifest["runAttempt"]:
            raise DeployError("Release workflow attempt does not match the manifest")
        ref = manifest.get("workflowRef", "").split("@", 1)[-1]
        if ref != f"refs/heads/{run.get('head_branch')}":
            raise DeployError("Release workflow ref does not match the executed branch")
        return run

    def find_release(self):
        prefix = self.c.get("releasePrefix", "patched-canary-")
        releases = [r for r in self.list_releases() if not r.get("draft") and r.get("prerelease") is True
                    and r.get("tag_name", "").startswith(prefix)]
        releases.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        last_error = None
        for release in releases:
            try:
                assets = {a.get("name"): a for a in release.get("assets", [])}
                if set(assets) != ASSET_NAMES:
                    raise DeployError("Release asset list must contain exactly manifest.json and payload.tar.gz")
                data = self.http.get(assets["manifest.json"]["browser_download_url"])
                self._verify_asset_digest(assets["manifest.json"], data, "manifest.json")
                manifest = _json_bytes(data, "Release manifest")
                verify_manifest(manifest, self.repository, self.workflow,
                                self.c.get("expectedPatches", self.c.get("patches")))
                if release["tag_name"] != f"{prefix}{manifest['version']}-{manifest['runId']}-{manifest['runAttempt']}":
                    raise DeployError("Release tag is not bound to its version and workflow run")
                if release.get("target_commitish") != manifest["controllerCommit"]:
                    raise DeployError("Release target commit does not match the manifest")
                self.verify_workflow_run(manifest)
                return release, manifest, assets
            except (DeployError, KeyError, ValueError) as exc:
                last_error = exc
                continue
        if last_error:
            raise DeployError(f"No verified green release found: {last_error}")
        raise DeployError("No patched Canary release is published")

    def _verify_asset_digest(self, asset: dict, data: bytes, expected_name: str):
        digest = asset.get("digest")
        if not isinstance(digest, str) or not digest.startswith("sha256:") or not HEX_64.fullmatch(digest[7:]):
            raise DeployError(f"GitHub did not publish a verified SHA-256 for {expected_name}")
        actual = sha256(data)
        if actual != digest[7:]:
            raise DeployError(f"Downloaded {expected_name} does not match the GitHub asset digest")
        return actual

    def _npm_metadata(self, version: str):
        packages = []
        for package in ("paperclipai", "@paperclipai/server"):
            encoded = urllib.parse.quote(package, safe="")
            metadata = _json_bytes(self.http.get(f"https://registry.npmjs.org/{encoded}/{version}"), "npm metadata")
            if metadata.get("version") != version:
                raise DeployError("Official npm package version differs from the release manifest")
            packages.append(package)
        return packages

    def stage(self, manifest: dict, assets: dict):
        self.installs.mkdir(parents=True, exist_ok=True)
        stem = f"{manifest['version']}-patched-{manifest['runId']}-{manifest['runAttempt']}"
        target = self.installs / stem
        if target.exists():
            try:
                self._verify_owned_candidate(target, manifest)
                return target, self._migration_diff(self.current_link.resolve(strict=True), target)
            except DeployError:
                self._remove_inactive_owned_candidate(target, manifest)
        npm_package = self._npm_metadata(manifest["version"])
        staging = self.installs / f".staging-{stem}-{os.getpid()}"
        if staging.exists():
            raise DeployError("Staging directory already exists")
        staging.mkdir(mode=0o700)
        try:
            npm_cmd = ["/usr/bin/npm", "install", "--prefix", str(staging),
                       *(f"{package}@{manifest['version']}" for package in npm_package),
                       "--registry=https://registry.npmjs.org/", "--@paperclipai:registry=https://registry.npmjs.org/",
                       "--no-audit", "--no-fund"]
            env = {**os.environ, "HOME": str(self.home)}
            result = self.command(npm_cmd, cwd=staging, env=env, capture_output=True, text=True, timeout=900)
            if result.returncode != 0:
                raise DeployError("Official npm install failed")
            for package_path in ("node_modules/paperclipai/package.json", "node_modules/@paperclipai/server/package.json"):
                package_json = staging / package_path
                if not package_json.is_file() or json.loads(package_json.read_text(encoding="utf-8")).get("version") != manifest["version"]:
                    raise DeployError("Staged npm package set or version does not match the manifest")

            manifest_data = self.http.get(assets["manifest.json"]["browser_download_url"])
            self._verify_asset_digest(assets["manifest.json"], manifest_data, "manifest.json")
            payload = self.http.get(assets["payload.tar.gz"]["browser_download_url"])
            payload_digest = self._verify_asset_digest(assets["payload.tar.gz"], payload, "payload.tar.gz")
            if payload_digest != manifest.get("archiveSha256"):
                raise DeployError("Payload archive digest does not match the release manifest")
            extraction = staging / ".release-payload"
            extraction.mkdir(mode=0o700)
            self._extract_payload(payload, extraction, manifest["files"])
            self._replace_package_roots(staging, extraction, manifest)
            shutil.rmtree(extraction)
            self._verify_candidate_files(staging, manifest)
            self._verify_migrations(staging, manifest)
            self._apply_local_hooks(staging)
            self._verify_local_hook_files(staging)
            self._verify_registered_support_files()
            candidate_files = {name: hash_file(staging.joinpath(*_safe_relative(name).parts))
                               for name in manifest["files"]}
            protected_files = self._protected_inventory(staging, manifest["packageMap"].values())
            marker = {"schemaVersion": 1, "repository": self.repository, "tag": manifest.get("tag"),
                      "version": manifest["version"], "runId": manifest["runId"],
                      "runAttempt": manifest["runAttempt"], "patchedCommit": manifest["patchedCommit"],
                      "archiveSha256": manifest["archiveSha256"], "candidateFiles": candidate_files,
                      "protectedRoots": sorted(manifest["packageMap"].values()),
                      "protectedFiles": protected_files}
            (staging / ".canary-train-owned.json").write_text(
                json.dumps(marker, sort_keys=True) + "\n", encoding="utf-8")
            os.replace(staging, target)
            self._prune_owned_candidates(target)
            return target, self._migration_diff(self.current_link.resolve(strict=True), target)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    def _verify_registered_support_files(self):
        hooks = self.c.get("hooks", [])
        required = {"codex-auth", "communication-policy", "direct-path-policy", "review-tool-access", "tool-review-probe"}
        if not isinstance(hooks, list) or {h.get("kind") for h in hooks if isinstance(h, dict)} != required:
            raise DeployError("Local hook registry is incomplete")
        for hook in hooks:
            path, digest = Path(hook.get("path", "")), hook.get("sha256")
            if not path.is_absolute() or not isinstance(digest, str) or not HEX_64.fullmatch(digest):
                raise DeployError("Local hook registration is invalid")
            if not path.is_file() or hash_file(path) != digest:
                raise DeployError("A registered local hook changed")
        support = self.c.get("supportFiles", {})
        if not isinstance(support, dict) or not support:
            raise DeployError("Support file registry is invalid")
        for name, digest in support.items():
            path = Path(name)
            if not path.is_absolute() or not isinstance(digest, str) or not HEX_64.fullmatch(digest):
                raise DeployError("Support file registry is invalid")
            if not path.is_file() or hash_file(path) != digest:
                raise DeployError("A registered service-owned support file changed")

    def _verify_owned_candidate(self, candidate: Path, manifest: dict):
        root = self.installs.resolve(strict=True)
        if candidate.is_symlink() or not candidate.is_dir() or candidate.resolve().parent != root:
            raise DeployError("Existing candidate path is unsafe")
        marker_path = candidate / ".canary-train-owned.json"
        if marker_path.is_symlink() or not marker_path.is_file():
            raise DeployError("Existing candidate is not registered as train-owned")
        marker = _json_bytes(marker_path.read_bytes(), "Candidate ownership receipt")
        identity = (marker.get("schemaVersion") == 1 and marker.get("repository") == self.repository and
                    marker.get("tag") == manifest.get("tag") and marker.get("version") == manifest["version"] and
                    marker.get("runId") == manifest["runId"] and marker.get("runAttempt") == manifest["runAttempt"] and
                    marker.get("patchedCommit") == manifest["patchedCommit"] and
                    marker.get("archiveSha256") == manifest["archiveSha256"])
        if not identity:
            raise DeployError("Existing candidate receipt does not match the verified release")
        expected = marker.get("candidateFiles")
        if not isinstance(expected, dict) or set(expected) != set(manifest["files"]):
            raise DeployError("Existing candidate file receipt is incomplete")
        for name, digest in expected.items():
            path = candidate.joinpath(*_safe_relative(name).parts)
            if path.is_symlink() or not path.is_file() or not isinstance(digest, str) or hash_file(path) != digest:
                raise DeployError("Existing candidate runtime files changed")
        roots = marker.get("protectedRoots")
        protected = marker.get("protectedFiles")
        if roots != sorted(manifest["packageMap"].values()) or not isinstance(protected, dict):
            raise DeployError("Existing candidate protected-file receipt is invalid")
        if self._protected_inventory(candidate, roots) != protected:
            raise DeployError("Existing candidate protected files changed")
        if _file_inventory(candidate, MIGRATION_ROOT.rstrip("/")) != {
                item["path"]: item["sha256"] for item in manifest["migrations"]}:
            raise DeployError("Existing candidate migration inventory changed")
        self._verify_registered_support_files()
        self._verify_local_hook_files(candidate)

    def _remove_inactive_owned_candidate(self, candidate: Path, manifest: dict):
        root = self.installs.resolve(strict=True)
        if candidate.is_symlink() or candidate.resolve().parent != root:
            raise DeployError("Refusing to replace an unsafe existing candidate")
        with contextlib.suppress(FileNotFoundError, OSError):
            if self.current_link.resolve(strict=True) == candidate.resolve():
                raise DeployError("Active candidate failed integrity verification; refusing to replace it")
        marker_path = candidate / ".canary-train-owned.json"
        if marker_path.is_symlink() or not marker_path.is_file():
            raise DeployError("Existing candidate is unmarked; refusing to replace it")
        marker = _json_bytes(marker_path.read_bytes(), "Candidate ownership receipt")
        if not (marker.get("schemaVersion") == 1 and marker.get("repository") == self.repository and
                marker.get("tag") == manifest.get("tag") and marker.get("version") == manifest["version"] and
                marker.get("runId") == manifest["runId"] and marker.get("runAttempt") == manifest["runAttempt"] and
                marker.get("patchedCommit") == manifest["patchedCommit"] and
                marker.get("archiveSha256") == manifest["archiveSha256"]):
            raise DeployError("Existing candidate receipt does not authorize replacement")
        shutil.rmtree(candidate)

    def _prune_owned_candidates(self, newest: Path):
        """Retain active/history candidates plus three newest owned candidates."""
        try:
            root = self.installs.resolve(strict=True)
            current = self.current_link.resolve(strict=True)
            install = self._read_install()
            preserved = {current}
            preserved.add(Path(install.get("payloadPath", "")).resolve())
            for entry in install.get("previous", []):
                if isinstance(entry, dict) and isinstance(entry.get("payloadPath"), str):
                    preserved.add(Path(entry["payloadPath"]).resolve())
            owned = []
            for candidate in root.iterdir():
                if candidate.is_symlink() or not candidate.is_dir() or candidate.resolve().parent != root:
                    continue
                receipt_path = candidate / ".canary-train-owned.json"
                if receipt_path.is_symlink() or not receipt_path.is_file():
                    continue
                try:
                    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if (receipt.get("schemaVersion") != 1 or receipt.get("repository") != self.repository or
                        not receipt.get("tag") or not receipt.get("patchedCommit")):
                    continue
                owned.append(candidate.resolve())
            keep = preserved | {p for p in sorted(owned, key=lambda p: p.stat().st_mtime, reverse=True)[:3]}
            keep.add(newest.resolve())
            for candidate in owned:
                if candidate in keep:
                    continue
                if candidate.parent == root and candidate != current:
                    shutil.rmtree(candidate)
        except Exception:
            # Retention is best-effort; a cleanup problem must not invalidate a
            # fully verified candidate or obscure the original staging error.
            return

    def _extract_payload(self, archive: bytes, destination: Path, expected_files: dict):
        seen = set()
        with tarfile.open(fileobj=__import__("io").BytesIO(archive), mode="r:gz") as tar:
            members = tar.getmembers()
            for member in members:
                path = _safe_relative(member.name.rstrip("/"))
                if member.isdir():
                    continue
                if not member.isfile() or member.issym() or member.islnk() or member.isdev():
                    raise DeployError("Release archive contains a non-regular file")
                name = path.as_posix()
                if name in seen or name not in expected_files:
                    raise DeployError("Release archive contains a duplicate or unmanifested path")
                seen.add(name)
                data_stream = tar.extractfile(member)
                if data_stream is None:
                    raise DeployError("Release archive file cannot be read")
                data = data_stream.read()
                if sha256(data) != expected_files[name]:
                    raise DeployError(f"Release file digest mismatch: {name}")
                out = destination.joinpath(*path.parts)
                out.parent.mkdir(parents=True, exist_ok=True)
                with out.open("wb") as stream:
                    stream.write(data)
            if seen != set(expected_files):
                raise DeployError("Release archive is missing manifest-listed files")

    def _verify_candidate_files(self, root: Path, manifest: dict):
        for name, digest in manifest["files"].items():
            path = root.joinpath(*_safe_relative(name).parts)
            if path.is_symlink() or not path.is_file() or hash_file(path) != digest:
                raise DeployError(f"Candidate file did not verify: {name}")
        entrypoint = root / "node_modules/paperclipai/dist/index.js"
        if not entrypoint.is_file():
            raise DeployError("Staged candidate is missing the Paperclip CLI entrypoint")

    def _replace_package_roots(self, candidate: Path, extracted: Path, manifest: dict):
        roots = sorted(manifest["packageMap"].values(), key=lambda value: (len(PurePosixPath(value).parts), value))
        for value in roots:
            rel = _safe_relative(value)
            source = extracted.joinpath(*rel.parts)
            target = candidate.joinpath(*rel.parts)
            single_file = value in manifest["files"]
            if source.is_symlink() or (single_file and not source.is_file()) or (not single_file and not source.is_dir()):
                raise DeployError(f"Verified release root is missing: {value}")
            cursor = candidate
            for part in rel.parts[:-1] if single_file else rel.parts:
                cursor = cursor / part
                if cursor.is_symlink():
                    raise DeployError("npm candidate contains a symlink inside a replacement path")
            if single_file:
                if target.is_symlink() or (target.exists() and not target.is_file()):
                    raise DeployError("npm candidate file replacement path is unsafe")
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(target.name + f".canary-{os.getpid()}.tmp")
                if temp.exists() or temp.is_symlink():
                    raise DeployError("Temporary package file path already exists")
                shutil.copyfile(source, temp)
                os.replace(temp, target)
                continue
            if target.exists():
                if not target.is_dir() or target.is_symlink():
                    raise DeployError("npm candidate replacement root is not a real directory")
                shutil.rmtree(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, target, symlinks=False)

    def _migration_diff(self, current: Path, candidate: Path):
        current = current.resolve(strict=True)
        old = _file_inventory(current, MIGRATION_ROOT.rstrip("/"))
        new = _file_inventory(candidate, MIGRATION_ROOT.rstrip("/"))
        if not old or not new:
            raise DeployError("Could not establish both installed and candidate migration inventories")
        changed = sorted(name for name, digest in old.items() if new.get(name) != digest)
        removed = sorted(set(old) - set(new))
        added = sorted(set(new) - set(old))
        if changed or removed or added:
            raise DeployError("Candidate database migration inventory is not identical; deployment deferred")
        return {"added": added, "changed": changed, "removed": removed, "inventory": new,
                "baselinePath": str(current), "baselineInventory": old}

    def _verify_migrations(self, candidate: Path, manifest: dict):
        actual = _file_inventory(candidate, MIGRATION_ROOT.rstrip("/"))
        expected = {m["path"]: m["sha256"] for m in manifest["migrations"]}
        actual = {k: v for k, v in actual.items() if k.startswith(MIGRATION_ROOT)}
        if actual != expected:
            raise DeployError("Candidate database migration inventory differs from its manifest")

    def _apply_local_hooks(self, candidate: Path):
        hooks = self.c.get("hooks", [])
        if not isinstance(hooks, list):
            raise DeployError("Local hook registry is invalid")
        allowed = {"codex-auth", "communication-policy", "direct-path-policy", "review-tool-access", "tool-review-probe"}
        kinds = set()
        for hook in hooks:
            if not isinstance(hook, dict) or hook.get("kind") not in allowed:
                raise DeployError("Local hook kind is unknown")
            kind, path, digest = hook["kind"], Path(hook.get("path", "")), hook.get("sha256")
            if not path.is_absolute() or not isinstance(digest, str) or not HEX_64.fullmatch(digest):
                raise DeployError("Local hook registration is invalid")
            if not path.is_file() or hash_file(path) != digest:
                raise DeployError(f"Registered local hook changed: {kind}")
            if kind in kinds:
                raise DeployError(f"Duplicate local hook: {kind}")
            kinds.add(kind)
        required = {"codex-auth", "communication-policy", "direct-path-policy", "review-tool-access", "tool-review-probe"}
        if kinds != required:
            raise DeployError("Local hook registry is incomplete")
        support_files = self.c.get("supportFiles", {})
        if not isinstance(support_files, dict):
            raise DeployError("Support file registry is invalid")
        for path, digest in support_files.items():
            source = Path(path)
            if not source.is_absolute() or not isinstance(digest, str) or not HEX_64.fullmatch(digest):
                raise DeployError("Support file registry is invalid")
            if not source.is_file() or hash_file(source) != digest:
                raise DeployError("A registered service-owned support file changed")

        hooks_by_kind = {h["kind"]: h for h in hooks}
        # Load only the pinned updater module and call its bounded patch function.
        updater_hook = hooks_by_kind["codex-auth"]
        spec = importlib.util.spec_from_file_location("paperclip_pinned_legacy_updater", updater_hook["path"])
        if spec is None or spec.loader is None:
            raise DeployError("Pinned Codex preservation hook cannot be loaded")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.patch_codex_mods(candidate)

        self._apply_instruction_policy(candidate, hooks_by_kind["communication-policy"],
                                       "plain-language:v2", ("default", "ceo"), module)
        self._apply_direct_path_policy(candidate, hooks_by_kind["direct-path-policy"])
        self._apply_review_hook(candidate, hooks_by_kind["review-tool-access"])
        probe = hooks_by_kind["tool-review-probe"]
        self.command(["/usr/bin/node", "--experimental-vm-modules", probe["path"],
                      str(candidate / "node_modules/@paperclipai/server/dist"), "patched"],
                     check=True, capture_output=True, text=True, timeout=60)

    def _apply_instruction_policy(self, candidate: Path, hook: dict, marker: str, roles, updater_module):
        policy_path = Path(hook.get("policyPath", hook["path"]))
        if policy_path != Path(hook["path"]) or not policy_path.is_file():
            raise DeployError("Communication policy hook must point to its registered policy file")
        if marker != "plain-language:v2" or not callable(getattr(updater_module, "apply_communication_defaults", None)):
            raise DeployError("Pinned communication policy handler is unavailable")
        updater_module.apply_communication_defaults(candidate, policy_file=policy_path)

    @staticmethod
    def _replace_managed_block(original: str, block: str, begin: str, end: str):
        count_begin, count_end = original.count(begin), original.count(end)
        if count_begin != count_end or count_begin > 1:
            raise DeployError("Managed instruction block is ambiguous")
        if count_begin:
            start = original.index(begin)
            finish = original.index(end, start) + len(end)
            while finish < len(original) and original[finish] == "\n":
                finish += 1
            updated = original[:start] + block.rstrip() + "\n\n" + original[finish:]
        elif original.startswith("<!-- paperclip-plain-language:v2:start -->") and begin == "<!-- paperclip-direct-path:v1:start -->":
            comm_end = "<!-- paperclip-plain-language:v2:end -->"
            if original.count(comm_end) != 1:
                raise DeployError("Communication block cannot be located")
            offset = original.index(comm_end) + len(comm_end)
            if original[offset:offset + 2] == "\n\n":
                offset += 2
            updated = original[:offset] + block.rstrip() + "\n\n" + original[offset:]
        else:
            updated = block.rstrip() + "\n\n" + original
        if updated.count(begin) != 1 or updated.count(end) != 1:
            raise DeployError("Managed instruction block failed readback")
        return updated

    def _apply_direct_path_policy(self, candidate: Path, hook: dict):
        path = Path(hook["path"])
        policy_path = Path(hook.get("policyPath", ""))
        policy_hash = hook.get("policySha256")
        if not policy_path.is_absolute() or not policy_path.is_file() or not isinstance(policy_hash, str) or hash_file(policy_path) != policy_hash:
            raise DeployError("Direct-path policy is missing or changed")
        spec = importlib.util.spec_from_file_location("paperclip_pinned_direct_path", path)
        if spec is None or spec.loader is None:
            raise DeployError("Pinned direct-path helper cannot be loaded")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        apply = getattr(module, "apply_direct_path_defaults", None)
        if not callable(apply):
            raise DeployError("Pinned direct-path helper has no supported entry point")
        apply(candidate, policy_file=policy_path)

    def _apply_review_hook(self, candidate: Path, hook: dict):
        bundle = Path(hook.get("bundlePath", ""))
        manifest_hash = hook.get("bundleManifestSha256")
        script = Path(hook["path"])
        if not bundle.is_absolute() or not script.is_file():
            raise DeployError("Pinned review/OpenCode preservation bundle is unavailable")
        bundle_manifest = bundle / "manifest.json"
        if not bundle_manifest.is_file() or not isinstance(manifest_hash, str) or hash_file(bundle_manifest) != manifest_hash:
            raise DeployError("Review/OpenCode bundle manifest changed")
        self.command([sys.executable, str(script), str(bundle), str(candidate)],
                     check=True, capture_output=True, text=True, timeout=120)

    def _verify_local_hook_files(self, candidate: Path):
        # Hook applications may only modify their explicitly reviewed targets.
        for role in ("default", "ceo"):
            path = candidate / "node_modules/@paperclipai/server/dist/onboarding-assets" / role / "AGENTS.md"
            if not path.is_file() or not path.read_text(encoding="utf-8").strip():
                raise DeployError("Service-managed agent instructions failed readback")
        auth = candidate / "node_modules/@paperclipai/adapter-codex-local/dist/server"
        for name in ("parse.js", "acp.js"):
            result = self.command(["/usr/bin/node", "--check", str(auth / name)],
                                 check=True, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                raise DeployError("Codex preservation hook produced invalid JavaScript")

    def load_token(self):
        auth_path = Path(self.c.get("authFile", str(self.home / ".paperclip/auth.json")))
        if not auth_path.is_file():
            raise DeployError("Existing Paperclip operator credential file is unavailable")
        auth = _json_bytes(auth_path.read_bytes(), "Operator credential file")
        matches = []
        for credential in (auth.get("credentials") or {}).values():
            base = str(credential.get("apiBase", "")).rstrip("/")
            user_id = credential.get("userId")
            token = credential.get("token") or credential.get("accessToken")
            if base in {self.api, self.api + "/api"} and user_id == self.c.get("authUserId") and isinstance(token, str) and token:
                matches.append(token)
        if len(matches) != 1:
            raise DeployError("Could not uniquely resolve the existing local Paperclip operator credential")
        return matches[0]

    def api_json(self, path: str, method="GET", body=None, token=None):
        return self.http.request_json(self.api + "/api" + path, method, body, token)

    def assert_no_work(self, token: str):
        status = self.api_json("/instance/task-drain", token=token)
        if not isinstance(status, dict) or status.get("draining") is not False or status.get("ownerId") is not None:
            raise DeployError("Paperclip already has an active task drain or returned an unknown state")
        if status.get("activeRuns") != 0 or status.get("pendingWakes") != 0:
            raise DeployError("Paperclip has active runs or pending wakes")
        companies = self.api_json("/companies", token=token)
        if isinstance(companies, dict):
            companies = companies.get("companies")
        if not isinstance(companies, list) or not companies:
            raise DeployError("Could not establish the complete Paperclip company inventory")
        for company in companies:
            company_id = company.get("id") if isinstance(company, dict) else None
            if not isinstance(company_id, str) or not company_id:
                raise DeployError("Paperclip company inventory is malformed")
            runs = self.api_json(f"/companies/{urllib.parse.quote(company_id, safe='')}/live-runs?limit=50&minCount=0", token=token)
            if not isinstance(runs, list) or len(runs) >= 50:
                raise DeployError("Live-run inventory is incomplete or at its limit")
            if runs:
                raise DeployError("Paperclip has queued or running work")

    def start_drain(self, token: str):
        drain = self.api_json("/instance/task-drain", "POST", {"purpose": "idle", "ttlMs": 300000}, token)
        if not isinstance(drain, dict) or drain.get("draining") is not True or not isinstance(drain.get("ownerId"), str):
            raise DeployError("Paperclip did not confirm ownership of the idle drain")
        return drain["ownerId"]

    def verify_owned_drain(self, token: str, owner: str):
        status = self.api_json("/instance/task-drain", token=token)
        if not isinstance(status, dict) or status.get("ownerId") != owner or status.get("draining") is not True:
            raise DeployError("Paperclip idle drain ownership changed")
        if status.get("activeRuns") != 0 or status.get("pendingWakes") != 0:
            raise DeployError("Work appeared after the idle drain started")
        # Company endpoints are intentionally admission-gated once an idle
        # drain is held. The owner-scoped safety report is the authoritative
        # post-hold check for HTTP, plugin, local, and persisted database work.
        self.assert_idle_checkpoint_disabled()
        report = self.api_json("/instance/task-drain?idleSleepSafety=1&ownerId=" +
                               urllib.parse.quote(owner, safe=""), token=token)
        safety = report.get("idleSleepSafety") if isinstance(report, dict) else None
        if (not isinstance(safety, dict) or safety.get("version") != 1 or
                safety.get("backgroundWork") != "none"):
            raise DeployError("Paperclip idle-work safety report is not definitively clear")

    def assert_idle_checkpoint_disabled(self):
        """Prevent the safety probe from creating a backup checkpoint."""
        service = self.c.get("serviceName", "paperclip")
        result = self.command(["systemctl", "show", "--property=MainPID", "--value", service],
                              capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            raise DeployError("Could not verify the Paperclip service process before idle-work inspection")
        pid = result.stdout.strip()
        if not pid.isdigit() or pid == "0":
            raise DeployError("Paperclip service has no verifiable main process")
        try:
            environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        except OSError as exc:
            raise DeployError("Could not inspect the Paperclip idle-checkpoint setting") from exc
        key = b"PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED="
        enabled = next((entry[len(key):] for entry in environment if entry.startswith(key)), b"")
        if enabled == b"1":
            raise DeployError("Idle-work inspection could create a backup checkpoint; refusing to proceed")

    def assert_no_company_runs(self, token):
        companies = self.api_json("/companies", token=token)
        if isinstance(companies, dict):
            companies = companies.get("companies")
        if not isinstance(companies, list) or not companies:
            raise DeployError("Could not establish the complete Paperclip company inventory")
        for company in companies:
            company_id = company.get("id") if isinstance(company, dict) else None
            if not isinstance(company_id, str):
                raise DeployError("Paperclip company inventory is malformed")
            runs = self.api_json(f"/companies/{urllib.parse.quote(company_id, safe='')}/live-runs?limit=50&minCount=0", token=token)
            if not isinstance(runs, list) or len(runs) >= 50:
                raise DeployError("Live-run inventory is incomplete or at its limit")
            if runs:
                raise DeployError("Queued or running work appeared before activation")

    def release_drain(self, token: str, owner: str):
        self.api_json("/instance/task-drain?ownerId=" + urllib.parse.quote(owner, safe=""), "DELETE", token=token)

    def _read_install(self):
        try:
            return json.loads(self.install_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise DeployError("Current install manifest is missing or invalid") from exc

    def _protected_inventory(self, payload: Path, roots):
        inventory = {}
        for root in roots:
            relative = _safe_relative(root).as_posix()
            base = payload.joinpath(*PurePosixPath(relative).parts)
            cursor = payload
            for part in PurePosixPath(relative).parts:
                cursor = cursor / part
                if cursor.is_symlink():
                    raise DeployError("Protected runtime root contains a symlink")
            if not (base.is_dir() or base.is_file()):
                raise DeployError("Protected runtime root is missing or unsafe")
            if base.is_file():
                inventory[relative] = hash_file(base)
                continue
            for path in sorted(base.rglob("*")):
                if path.is_symlink():
                    raise DeployError("Protected runtime inventory contains a symlink")
                if path.is_file():
                    inventory[path.relative_to(payload).as_posix()] = hash_file(path)
        for role in ("default", "ceo"):
            relative = f"node_modules/@paperclipai/server/dist/onboarding-assets/{role}/AGENTS.md"
            path = payload.joinpath(*PurePosixPath(relative).parts)
            if path.is_symlink() or not path.is_file():
                raise DeployError("Service-managed agent instruction is missing or unsafe")
            inventory[relative] = hash_file(path)
        return inventory

    def _verify_active_fingerprint(self, current: Path, install: dict):
        receipt = install.get("patchedRelease") or {}
        expected = receipt.get("protectedFiles")
        roots = receipt.get("protectedRoots")
        if not isinstance(expected, dict) or not expected:
            if install.get("version") == self.c.get("activeVersion"):
                expected = self.c.get("activeFiles")
                roots = self.c.get("activeRoots")
            else:
                expected = None
        if not isinstance(expected, dict) or not expected:
            raise DeployError("Active payload has no registered integrity receipt; refusing to replace it")
        if roots:
            actual = self._protected_inventory(current, roots)
            if actual != expected:
                raise DeployError("Active Paperclip payload differs from its registered integrity receipt")
            return actual
        actual = {}
        for name, digest in expected.items():
            relative = _safe_relative(name).as_posix()
            path = current.joinpath(*PurePosixPath(relative).parts)
            if path.is_symlink() or not path.is_file() or not isinstance(digest, str) or hash_file(path) != digest:
                raise DeployError("Active Paperclip payload differs from its registered integrity receipt")
            actual[relative] = digest
        return actual

    def _write_install_atomic(self, data: dict):
        temp = self.install_json.with_name(self.install_json.name + f".tmp-{os.getpid()}")
        self.install_json.parent.mkdir(parents=True, exist_ok=True)
        temp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(temp, self.install_json)

    @staticmethod
    def _replace_link(temp_link: Path, link: Path):
        try:
            os.replace(temp_link, link)
        except OSError:
            # Windows may refuse replace-over-symlink even when both entries
            # are links. Linux keeps the atomic replace path above.
            if not link.is_symlink() or not temp_link.is_symlink():
                raise
            link.unlink()
            os.replace(temp_link, link)

    def activate(self, candidate: Path, manifest: dict, migration_diff: dict, token: str):
        previous = self._read_install()
        old_target = self.current_link.resolve(strict=True)
        old_commit = self._build_commit(old_target)
        owner = None
        cutover_attempted = False
        restart_attempted = False
        try:
            if migration_diff.get("added") or migration_diff.get("changed") or migration_diff.get("removed"):
                raise DeployError("Candidate database migration inventory is not identical; activation refused")
            self.assert_no_work(token)
            owner = self.start_drain(token)
            self.verify_owned_drain(token, owner)
            # Recheck the old active package's migration baseline immediately
            # before switching; a concurrent manual update must defer this run.
            if self.current_link.resolve(strict=True) != old_target:
                raise DeployError("Active Paperclip payload changed during staging")
            active_migrations = _file_inventory(old_target, MIGRATION_ROOT.rstrip("/"))
            if (str(old_target) != migration_diff.get("baselinePath") or
                    active_migrations != migration_diff.get("baselineInventory") or
                    active_migrations != migration_diff.get("inventory")):
                raise DeployError("Active migration baseline changed after candidate staging")
            self.verify_owned_drain(token, owner)
            # The symlink and install receipt are two coordinated pieces of
            # state; mark cutover before either is mutated so partial writes
            # are always repaired on failure.
            cutover_attempted = True
            self._switch_current(candidate, manifest)
            restart_attempted = True
            result = self.command(["sudo", "-n", "systemctl", "restart", self.c.get("serviceName", "paperclip")],
                                  capture_output=True, text=True, timeout=90)
            if result.returncode != 0:
                raise DeployError("Paperclip service restart was rejected")
            if not self._wait_health(manifest["version"], manifest["patchedCommit"]):
                raise DeployError("Candidate health check failed")
            self._verify_active(manifest["version"])
            return {"version": manifest["version"], "payloadPath": str(candidate), "migrationDiff": migration_diff}
        except Exception as original:
            if cutover_attempted:
                try:
                    self._restore_current(old_target, previous)
                    if restart_attempted:
                        result = self.command(["sudo", "-n", "systemctl", "restart", self.c.get("serviceName", "paperclip")],
                                              capture_output=True, text=True, timeout=90)
                        if result.returncode != 0 or not self._wait_health(previous.get("version"), old_commit):
                            raise DeployError("Previous Paperclip payload did not recover after rollback")
                except Exception as rollback_error:
                    raise DeployError("Cutover failed and rollback could not be verified; service state needs attention") from rollback_error
            raise
        finally:
            if owner:
                with contextlib.suppress(Exception):
                    self.release_drain(token, owner)

    def _switch_current(self, candidate: Path, manifest: dict):
        protected_files = self._protected_inventory(candidate, manifest["packageMap"].values())
        temp_link = self.cli_root / f".current.tmp-{os.getpid()}"
        if temp_link.exists() or temp_link.is_symlink():
            temp_link.unlink()
        temp_link.symlink_to(candidate.resolve())
        self._replace_link(temp_link, self.current_link)
        old = self._read_install()
        record = {"source": "npm", "version": old.get("version", "unknown"), "channel": old.get("channel", "canary"),
                  "payloadPath": old.get("payloadPath", str(self.current_link)), "installedAt": old.get("installedAt")}
        new = {"schemaVersion": 1, "source": "npm", "version": manifest["version"], "channel": "canary",
               "payloadPath": str(candidate.resolve()), "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "previous": [record] + list(old.get("previous", []))[:2],
               "patchedRelease": {"repository": self.repository, "tag": manifest.get("tag"),
                                  "sourceCommit": manifest["sourceCommit"], "patchedCommit": manifest["patchedCommit"],
                                  "controllerCommit": manifest["controllerCommit"], "patches": manifest["patches"],
                                  "protectedRoots": sorted(manifest["packageMap"].values()),
                                  "protectedFiles": protected_files}}
        self._write_install_atomic(new)

    def _restore_current(self, old_target: Path, previous: dict):
        temp_link = self.cli_root / f".current.rollback-{os.getpid()}"
        if temp_link.exists() or temp_link.is_symlink():
            temp_link.unlink()
        temp_link.symlink_to(old_target)
        self._replace_link(temp_link, self.current_link)
        self._write_install_atomic(previous)

    @staticmethod
    def _build_commit(payload: Path):
        path = payload / "node_modules/@paperclipai/server/dist/build-info.json"
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            commit = value.get("commit") if isinstance(value, dict) else None
            return commit if isinstance(commit, str) and HEX_40.fullmatch(commit) else None
        except (OSError, json.JSONDecodeError):
            return None

    def _wait_health(self, expected_version: str, expected_commit=None, timeout=90):
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            try:
                data = self.api_json("/health")
                if isinstance(data, dict) and data.get("status") in {"ok", "ready"}:
                    installed = self._read_install()
                    version_ok = data.get("version", data.get("serverVersion")) == expected_version
                    commit_ok = expected_commit is None or data.get("commit") == expected_commit
                    if installed.get("version") == expected_version and version_ok and commit_ok:
                        return True
            except Exception:
                pass
            time.sleep(2)
        return False

    def _verify_active(self, expected_version: str):
        if self.current_link.resolve(strict=True) != Path(self._read_install()["payloadPath"]).resolve():
            raise DeployError("Active symlink and install manifest disagree")
        if self._read_install().get("version") != expected_version:
            raise DeployError("Active Paperclip version does not match the verified release")
        receipt = self._read_install().get("patchedRelease") or {}
        if not self._wait_health(expected_version, receipt.get("patchedCommit"), timeout=5):
            raise DeployError("Paperclip health readback failed")

    def run(self, mode="check"):
        install = self._read_install()
        current = self.current_link.resolve(strict=True)
        self._verify_active_fingerprint(current, install)
        try:
            release, manifest, assets = self.find_release()
        except DeployError as exc:
            if "No patched Canary release is published" in str(exc) or "No verified green release found" in str(exc):
                self._write_status({"state": "waiting", "reason": "No verified green public fork release is available"})
                return {"available": False, "state": "waiting"}
            raise
        manifest = dict(manifest)
        manifest["tag"] = release["tag_name"]
        current_tag = (install.get("patchedRelease") or {}).get("tag")
        if current_tag == release["tag_name"]:
            self._write_status({"state": "current", "tag": release["tag_name"], "version": manifest["version"]})
            return {"available": True, "current": True, "tag": release["tag_name"], "version": manifest["version"]}
        if mode == "check":
            self._write_status({"state": "available", "tag": release["tag_name"], "version": manifest["version"]})
            return {"available": True, "tag": release["tag_name"], "version": manifest["version"], "patches": manifest["patches"]}
        candidate, migration_diff = self.stage(manifest, assets)
        if mode == "stage":
            self._write_status({"state": "staged", "tag": release["tag_name"], "version": manifest["version"]})
            return {"staged": True, "version": manifest["version"], "payloadPath": str(candidate), "migrationDiff": migration_diff}
        token = self.load_token()
        result = {"activated": True, **self.activate(candidate, manifest, migration_diff, token)}
        self._write_status({"state": "active", "tag": release["tag_name"], "version": manifest["version"]})
        return result

    def _write_status(self, data):
        path = Path(self.c.get("statusFile", str(self.home / "autoupdate/canary-train/status.json")))
        if not path.is_absolute():
            raise DeployError("Status file path must be absolute")
        path.parent.mkdir(parents=True, exist_ok=True)
        state = {"schemaVersion": 1, "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), **data}
        tmp = path.with_name(path.name + f".tmp-{os.getpid()}")
        tmp.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(tmp, path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--stage", action="store_true")
    mode.add_argument("--run", action="store_true")
    args = parser.parse_args(argv)
    config = None
    try:
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        result = Deployer(config).run("run" if args.run else "stage" if args.stage else "check")
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, DeployError, subprocess.SubprocessError) as exc:
        if isinstance(config, dict):
            with contextlib.suppress(Exception):
                Deployer(config)._write_status({"state": "blocked", "reason": str(exc)[:300]})
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
