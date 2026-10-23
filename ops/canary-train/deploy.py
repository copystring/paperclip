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


class ReleaseNotReady(DeployError):
    """A published release exists, but its producing workflow is still running."""


HEX_64 = re.compile(r"^[0-9a-f]{64}$")
HEX_40 = re.compile(r"^[0-9a-f]{40}$")
VERSION = re.compile(r"^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
ASSET_NAMES = {"manifest.json", "payload.tar.gz"}
MIGRATION_ROOT = "node_modules/@paperclipai/db/dist/migrations/"
RUNNER_TARGETS = {"darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"}
MIGRATION_RECEIPT_SCHEMA = 1
MIGRATION_PROBE_SCHEMA = 1
MIGRATION_PROBE_KIND = "migration-precondition-probe"


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
        retained_inactive = config.get("retainedInactiveCandidates", 3)
        if type(retained_inactive) is not int or retained_inactive < 0:
            raise DeployError("Inactive candidate retention must be a non-negative integer")
        self.retained_inactive_candidates = retained_inactive
        self._active_health_verified_identity = None
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
        # Only manifests whose producing workflow run was checked through the
        # GitHub API may carry a migration-compatibility receipt into staging.
        self._verified_workflow_contexts = {}
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
        if run.get("status") != "completed":
            raise ReleaseNotReady("Release workflow is still running")
        if run.get("conclusion") != "success":
            raise DeployError("Release workflow did not complete successfully")
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
        not_ready = None
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
                run = self.verify_workflow_run(manifest)
                self._verified_workflow_contexts[self._manifest_identity(manifest)] = {
                    "runId": manifest["runId"], "runAttempt": manifest["runAttempt"],
                    "controllerCommit": run["head_sha"], "sourceCommit": manifest["sourceCommit"],
                }
                return release, manifest, assets
            except ReleaseNotReady as exc:
                not_ready = exc
                continue
            except (DeployError, KeyError, ValueError) as exc:
                last_error = exc
                continue
        if last_error:
            raise DeployError(f"No verified green release found: {last_error}")
        if not_ready:
            raise not_ready
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
        stem = f"{manifest['version']}-patched-{manifest['runId']}-{manifest['runAttempt']}"
        target = self.installs / stem
        # Keep a previously verified target available for reuse while pruning.
        # Unowned or symlink targets are never admitted into the retention set.
        reusable_target = target if target.is_dir() and not target.is_symlink() else None
        self._prune_owned_candidates(reusable_target)
        if target.exists():
            try:
                self._verify_owned_candidate(target, manifest)
                return target, self._migration_diff(self.current_link.resolve(strict=True), target, manifest)
            except DeployError:
                self._remove_inactive_owned_candidate(target, manifest)
        archive_size = (assets.get("payload.tar.gz") or {}).get("size")
        if not isinstance(archive_size, int) or archive_size < 1:
            raise DeployError("GitHub payload asset size is invalid")
        minimum_free = self.c.get("minimumFreeBytes", 4 * 1024 ** 3)
        multiplier = self.c.get("stageDiskMultiplier", 3)
        if not isinstance(minimum_free, int) or minimum_free < 0 or not isinstance(multiplier, int) or multiplier < 1:
            raise DeployError("Disk safety configuration is invalid")
        free = shutil.disk_usage(self.home).free
        required = minimum_free + archive_size * multiplier
        if free < required:
            raise DeployError("Insufficient free disk space for a safe candidate stage")
        self.installs.mkdir(parents=True, exist_ok=True)
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
            self._verify_runner_release_assets(staging, manifest)
            self._apply_local_hooks(staging, manifest)
            self._verify_local_hook_files(staging, manifest)
            self._verify_registered_support_files()
            self._verify_runner_release_assets(staging, manifest)
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
            return target, self._migration_diff(self.current_link.resolve(strict=True), target, manifest)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    def _verify_registered_support_files(self):
        hooks = self.c.get("hooks", [])
        required = {"codex-auth", "communication-policy", "direct-path-policy", "review-tool-access", "tool-review-probe"}
        if not isinstance(hooks, list) or any(not isinstance(h, dict) for h in hooks):
            raise DeployError("Local hook registry is incomplete")
        kinds = [h.get("kind") for h in hooks]
        if (any(not isinstance(kind, str) for kind in kinds) or not required.issubset(kinds) or
                set(kinds) - required - {MIGRATION_PROBE_KIND} or len(kinds) != len(set(kinds))):
            raise DeployError("Local hook registry is incomplete")
        for hook in hooks:
            path, digest = Path(hook.get("path", "")), hook.get("sha256")
            if not path.is_absolute() or not isinstance(digest, str) or not HEX_64.fullmatch(digest):
                raise DeployError("Local hook registration is invalid")
            if not path.is_file() or hash_file(path) != digest:
                raise DeployError("A registered local hook changed")
            if hook.get("kind") == MIGRATION_PROBE_KIND and hook.get("readOnlyProduction") is not True:
                raise DeployError("Migration probe must declare read-only production access")
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
        self._verify_local_hook_files(candidate, manifest)
        self._verify_runner_release_assets(candidate, manifest)

    @staticmethod
    def _canonical_json(value):
        if isinstance(value, list):
            return "[" + ",".join(Deployer._canonical_json(item) for item in value) + "]"
        if isinstance(value, dict):
            return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + Deployer._canonical_json(value[key])
                                     for key in sorted(value)) + "}"
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _manifest_identity(manifest: dict) -> str:
        return sha256(Deployer._canonical_json(manifest).encode("utf-8"))

    @staticmethod
    def _inventory_identity(inventory: dict[str, str]) -> str:
        return sha256(Deployer._canonical_json(inventory).encode("utf-8"))

    @staticmethod
    def _runner_binary_target(data: bytes):
        if len(data) < 20:
            return None
        if data[:4] == b"\x7fELF" and data[4:6] == b"\x02\x01":
            machine = int.from_bytes(data[18:20], "little")
            return {62: "linux-x64", 183: "linux-arm64"}.get(machine)
        if int.from_bytes(data[:4], "little") == 0xFEEDFACF:
            cpu = int.from_bytes(data[4:8], "little")
            return {0x01000007: "darwin-x64", 0x0100000C: "darwin-arm64"}.get(cpu)
        return None

    def _verify_runner_release_assets(self, candidate: Path, manifest: dict):
        """Require release-assembled native runner targets in each staged runtime."""
        roots = [PurePosixPath("node_modules/@paperclipai/server/dist/vendor/paperclip-runner")]
        if "@paperclipai/paperclip-runner#dist" in manifest["packageMap"]:
            roots.append(PurePosixPath("node_modules/@paperclipai/paperclip-runner/dist"))
        manifest_files = manifest.get("files", {})

        def read_hashed(relative: PurePosixPath):
            name = relative.as_posix()
            if name not in manifest_files:
                raise DeployError(f"Native runner asset is absent from the verified payload inventory: {name}")
            expected = manifest_files[name]
            if not isinstance(expected, str) or not HEX_64.fullmatch(expected):
                raise DeployError("Native runner asset has an invalid payload digest")
            path = candidate.joinpath(*relative.parts)
            cursor = candidate
            for part in relative.parts:
                cursor = cursor / part
                if cursor.is_symlink():
                    raise DeployError("Native runner asset path contains a symlink")
            if not path.is_file() or hash_file(path) != expected:
                raise DeployError(f"Native runner asset does not match the verified payload: {name}")
            return path.read_bytes()

        for root in roots:
            release_manifest_path = root / "bin/release-manifest.json"
            release_bytes = read_hashed(release_manifest_path)
            release = _json_bytes(release_bytes, "Native runner release manifest")
            if release.get("schema") != "paperclip.runner.release-binaries.v1" or release.get("sourceRevision") != manifest["patchedCommit"]:
                raise DeployError("Native runner release manifest does not match the patched commit")
            platforms = release.get("platforms")
            if not isinstance(platforms, dict) or set(platforms) != RUNNER_TARGETS:
                raise DeployError("Native runner release must contain all four supported platform targets")
            for target in sorted(RUNNER_TARGETS):
                entry = platforms[target]
                expected_path = f"{target}/paperclip-runnerd"
                digest = entry.get("sha256") if isinstance(entry, dict) else None
                if (not isinstance(entry, dict) or entry.get("path") != expected_path or
                        not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)):
                    raise DeployError(f"Native runner {target} release entry is invalid")
                relative = root / "bin" / _safe_relative(expected_path)
                data = read_hashed(relative)
                if sha256(data) != digest[7:] or self._runner_binary_target(data) != target:
                    raise DeployError(f"Native runner {target} digest or architecture is invalid")
                # The release assembler normalizes every published runner to
                # 0755. Preserve that executable contract on Linux; checking
                # only the bytes would allow a correctly hashed but unusable
                # daemon to pass staging.
                if target.startswith("linux-") and os.name != "nt":
                    binary_path = candidate.joinpath(*relative.parts)
                    if stat.S_IMODE(binary_path.stat().st_mode) != 0o755:
                        raise DeployError(f"Native runner {target} must have mode 0755")
            provider_pack = release.get("remoteProviderPack")
            if provider_pack is not None:
                expected_path = root / "remote-provider-packs/linux-x64/provider-pack.json"
                pack_bytes = read_hashed(expected_path)
                pack = _json_bytes(pack_bytes, "Native runner remote provider pack")
                payload = pack.get("payload") if isinstance(pack, dict) else None
                identity = pack.get("digest") if isinstance(pack, dict) else None
                digest = "sha256:" + hashlib.sha256(self._canonical_json(payload).encode("utf-8")).hexdigest()
                if (not isinstance(pack, dict) or pack.get("schema") != "paperclip-runner/remote-provider-pack/v1" or
                        not isinstance(provider_pack, dict) or provider_pack.get("target") != "linux-x64" or
                        provider_pack.get("sourceRevision") != manifest["patchedCommit"] or
                        provider_pack.get("digest") != identity or identity != digest or
                        not isinstance(payload, dict) or payload.get("runnerSourceRevision") != manifest["patchedCommit"] or
                        payload.get("target") != {"platform": "linux", "architecture": "x64"}):
                    raise DeployError("Native runner remote provider-pack reference is invalid")

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

    def _prune_owned_candidates(self, newest: Path | None = None):
        """Prune only owned candidates, retaining the active/history set by policy."""
        try:
            root = self.installs.resolve(strict=True)
            current = self.current_link.resolve(strict=True)
            install = self._read_install()
            preserved = {current}
            preserved.add(Path(install.get("payloadPath", "")).resolve())
            # A zero retention count may remove old history payloads only after
            # the exact active install has passed its version/commit health
            # readback. Until then, an interrupted prior cutover may still need
            # one of those payloads for rollback.
            active_identity = None
            install_payload = install.get("payloadPath")
            if isinstance(install_payload, str):
                try:
                    if Path(install_payload).resolve(strict=True) == current:
                        active_identity = (
                            str(current), install.get("version"),
                            (install.get("patchedRelease") or {}).get("patchedCommit"),
                        )
                except OSError:
                    pass
            preserve_history = (self.retained_inactive_candidates != 0 or
                                active_identity is None or
                                active_identity != self._active_health_verified_identity)
            if preserve_history:
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
            keep = preserved | {
                p for p in sorted(owned, key=lambda p: p.stat().st_mtime, reverse=True)
                [:self.retained_inactive_candidates]
            }
            if newest is not None:
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

    @contextlib.contextmanager
    def deployment_lock(self):
        path = Path(self.c.get("lockFile", str(self.home / "autoupdate/autoupdate.lock")))
        if not path.is_absolute():
            raise DeployError("Deployment lock path must be absolute")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a+b") as stream:
            if os.name == "nt":
                # The production service is Linux. Keeping Windows imports
                # usable supports local unit tests without adding a dependency.
                yield
                return
            import fcntl
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise DeployError("Another Paperclip updater already holds the shared update lock") from exc
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

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
                if not isinstance(member.mode, int) or member.mode < 0 or member.mode & ~0o777:
                    raise DeployError("Release archive contains an unsafe file mode")
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
                os.chmod(out, member.mode)
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

    def _migration_diff(self, current: Path, candidate: Path, manifest: dict | None = None):
        current = current.resolve(strict=True)
        old = _file_inventory(current, MIGRATION_ROOT.rstrip("/"))
        new = _file_inventory(candidate, MIGRATION_ROOT.rstrip("/"))
        if not old or not new:
            raise DeployError("Could not establish both installed and candidate migration inventories")
        changed = sorted(name for name, digest in old.items() if new.get(name) != digest)
        removed = sorted(set(old) - set(new))
        added = sorted(set(new) - set(old))
        diff = {"added": added, "changed": changed, "removed": removed, "inventory": new,
                "baselinePath": str(current), "baselineInventory": old,
                "baselineInventorySha256": self._inventory_identity(old),
                "candidateInventorySha256": self._inventory_identity(new)}
        if changed or removed or added:
            if manifest is None:
                raise DeployError("Candidate database migration inventory is not identical; deployment deferred")
            diff["compatibility"] = self._validate_migration_compatibility(current, candidate, manifest, old, new)
        return diff

    def _database_package_identity(self, payload: Path):
        package_path = payload / "node_modules/@paperclipai/db/package.json"
        lock_path = payload / "node_modules/.package-lock.json"
        try:
            if package_path.is_symlink() or lock_path.is_symlink():
                raise DeployError("Database package identity contains a symlink")
            package = _json_bytes(package_path.read_bytes(), "Installed database package metadata")
            lock = _json_bytes(lock_path.read_bytes(), "Installed npm lock metadata")
        except OSError as exc:
            raise DeployError("Installed database package identity is unavailable") from exc
        entry = lock.get("packages", {}).get("node_modules/@paperclipai/db") if isinstance(lock, dict) else None
        version = package.get("version") if isinstance(package, dict) else None
        integrity = entry.get("integrity") if isinstance(entry, dict) else None
        if (not isinstance(version, str) or not VERSION.fullmatch(version) or
                not isinstance(integrity, str) or
                not re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", integrity)):
            raise DeployError("Installed database package identity is incomplete")
        return {"version": version, "integrity": integrity}

    def _approved_migration_transition(self, baseline_hash: str, candidate_hash: str):
        transitions = self.c.get("approvedMigrationTransitions", [])
        if not isinstance(transitions, list):
            raise DeployError("Approved migration transition registry is invalid")
        matches = []
        for item in transitions:
            if not isinstance(item, dict):
                raise DeployError("Approved migration transition entry is invalid")
            if (item.get("baselineInventorySha256") == baseline_hash and
                    item.get("candidateInventorySha256") == candidate_hash):
                matches.append(item)
        if len(matches) != 1:
            raise DeployError("Candidate database migration inventory is not identical; deployment deferred")
        return matches[0]

    def _validate_migration_compatibility(self, current: Path, candidate: Path, manifest: dict,
                                          baseline: dict, candidate_inventory: dict):
        baseline_hash = self._inventory_identity(baseline)
        candidate_hash = self._inventory_identity(candidate_inventory)
        transition = self._approved_migration_transition(baseline_hash, candidate_hash)
        context = self._verified_workflow_contexts.get(self._manifest_identity(manifest))
        if context is None:
            raise DeployError("Migration compatibility requires a verified successful workflow run")
        receipt = manifest.get("migrationCompatibilityReceipt")
        if (not isinstance(receipt, dict) or type(receipt.get("schemaVersion")) is not int or
                receipt.get("schemaVersion") != MIGRATION_RECEIPT_SCHEMA):
            raise DeployError("Migration compatibility receipt is missing or unsupported")
        expected_package = self._database_package_identity(current)
        if (receipt.get("baselineInventorySha256") != baseline_hash or
                receipt.get("candidateInventorySha256") != candidate_hash or
                type(receipt.get("baselineFileCount")) is not int or
                type(receipt.get("candidateFileCount")) is not int or
                receipt.get("baselineFileCount") != len(baseline) or
                receipt.get("candidateFileCount") != len(candidate_inventory) or
                receipt.get("baselinePackage") != expected_package):
            raise DeployError("Migration compatibility receipt does not match the installed transition")
        proof = receipt.get("upgradeProof")
        if (not isinstance(proof, dict) or proof.get("passed") is not True or
                type(proof.get("runAttempt")) is not int):
            raise DeployError("Migration compatibility upgrade proof is missing or failed")
        for field, expected in {**context, "patchCommit": manifest.get("patchedCommit")}.items():
            if proof.get(field) != expected:
                raise DeployError("Migration upgrade proof is not bound to the verified release workflow")
        assertions = proof.get("assertions")
        required_assertions = transition.get("requiredAssertions")
        if (not isinstance(required_assertions, list) or not required_assertions or
                any(not isinstance(value, str) or not value for value in required_assertions) or
                len(set(required_assertions)) != len(required_assertions) or
                not isinstance(assertions, list) or
                any(not isinstance(value, str) or not value for value in assertions) or
                len(set(assertions)) != len(assertions) or
                not set(required_assertions).issubset(assertions)):
            raise DeployError("Migration upgrade proof is missing required compatibility assertions")
        candidate_package = self._database_package_identity(candidate)
        if (candidate_package["version"] != manifest.get("version") or
                receipt.get("candidatePackage") != candidate_package):
            raise DeployError("Candidate database package differs from the tested accepted release")
        return {"status": "needsRuntimeCompatibility", "manifestSha256": self._manifest_identity(manifest),
                "baselineInventorySha256": baseline_hash, "candidateInventorySha256": candidate_hash,
                "baselinePackage": expected_package, "candidatePackage": candidate_package,
                "transition": transition}

    def _verify_migrations(self, candidate: Path, manifest: dict):
        actual = _file_inventory(candidate, MIGRATION_ROOT.rstrip("/"))
        expected = {m["path"]: m["sha256"] for m in manifest["migrations"]}
        actual = {k: v for k, v in actual.items() if k.startswith(MIGRATION_ROOT)}
        if actual != expected:
            raise DeployError("Candidate database migration inventory differs from its manifest")

    def _apply_local_hooks(self, candidate: Path, manifest: dict):
        hooks = self.c.get("hooks", [])
        if not isinstance(hooks, list):
            raise DeployError("Local hook registry is invalid")
        allowed = {"codex-auth", "communication-policy", "direct-path-policy", "review-tool-access", "tool-review-probe",
                   MIGRATION_PROBE_KIND}
        kinds = set()
        for hook in hooks:
            if not isinstance(hook, dict) or not isinstance(hook.get("kind"), str) or hook.get("kind") not in allowed:
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
        if not required.issubset(kinds):
            raise DeployError("Local hook registry is incomplete")
        probe = next((hook for hook in hooks if hook.get("kind") == MIGRATION_PROBE_KIND), None)
        if probe is not None and probe.get("readOnlyProduction") is not True:
            raise DeployError("Migration probe must declare read-only production access")
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
        self._apply_review_hook(candidate, hooks_by_kind["review-tool-access"], manifest)
        probe = hooks_by_kind["tool-review-probe"]
        self._run_review_probe(candidate, manifest, probe)

    def _run_review_probe(self, candidate: Path, manifest: dict, probe: dict):
        manifest_argument = probe.get("verifiedReleaseManifest", False)
        if type(manifest_argument) is not bool:
            raise DeployError("Probe manifest option must be a boolean")
        command = ["/usr/bin/node", "--experimental-vm-modules", probe["path"],
                   str(candidate / "node_modules/@paperclipai/server/dist"), "patched"]
        if not manifest_argument:
            self.command(command, check=True, capture_output=True, text=True, timeout=60)
            return
        if not self.c.get("requiredSourcePatches"):
            raise DeployError("Manifest-aware probes require registered source patches")
        self._verify_required_source_patches(manifest)
        # Pass only the same manifest accepted by package/source verification.
        # Keep it outside the payload inventory and remove it even on failure.
        with tempfile.TemporaryDirectory(prefix="paperclip-verified-manifest-") as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_bytes((self._canonical_json(manifest) + "\n").encode("utf-8"))
            manifest_path.chmod(0o600)
            self.command(command + [str(manifest_path)], check=True,
                         capture_output=True, text=True, timeout=60)

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

    def _verify_review_bundle_registration(self, hook: dict):
        bundle = Path(hook.get("bundlePath", ""))
        manifest_hash = hook.get("bundleManifestSha256")
        script = Path(hook["path"])
        script_hash = hook.get("sha256")
        if (not bundle.is_absolute() or bundle.is_symlink() or not bundle.is_dir() or
                not script.is_absolute() or script.is_symlink() or not script.is_file() or
                not isinstance(script_hash, str) or not HEX_64.fullmatch(script_hash) or
                hash_file(script) != script_hash):
            raise DeployError("Pinned review/OpenCode preservation bundle is unavailable")
        bundle_manifest = bundle / "manifest.json"
        if (bundle_manifest.is_symlink() or not bundle_manifest.is_file() or
                not isinstance(manifest_hash, str) or not HEX_64.fullmatch(manifest_hash) or
                hash_file(bundle_manifest) != manifest_hash):
            raise DeployError("Review/OpenCode bundle manifest changed")

    @staticmethod
    def _verify_source_replacement(hook: dict, manifest: dict):
        replacement = hook.get("sourceReplacement")
        if (not isinstance(replacement, dict) or set(replacement) != {"repository", "number", "head"} or
                not isinstance(replacement.get("repository"), str) or
                not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", replacement["repository"]) or
                not isinstance(replacement.get("number"), int) or isinstance(replacement["number"], bool) or
                replacement["number"] < 1 or not isinstance(replacement.get("head"), str) or
                not HEX_40.fullmatch(replacement["head"])):
            raise DeployError("Review-tool source replacement registration is invalid")
        patches = manifest.get("patches")
        if not isinstance(patches, list):
            raise DeployError("Verified release manifest has no patch-state inventory")
        matches = [patch for patch in patches if isinstance(patch, dict) and
                   patch.get("repository") == replacement["repository"] and
                   patch.get("number") == replacement["number"] and
                   patch.get("head") == replacement["head"]]
        if len(matches) != 1:
            raise DeployError("Verified release does not contain the registered review-tool replacement head")
        state = matches[0].get("state")
        if not isinstance(state, str) or state not in {
                "applied", "applied_three_way", "applied_integration", "already_present",
                "already_present_integration", "already_in_release"}:
            raise DeployError("Verified review-tool replacement patch state is not accepted")
        if state == "already_in_release" and not (
                isinstance(matches[0].get("mergeCommit"), str) and HEX_40.fullmatch(matches[0]["mergeCommit"])):
            raise DeployError("Verified in-release replacement is missing its merge commit")

    def _apply_review_hook(self, candidate: Path, hook: dict, manifest: dict):
        # Keep the historical compiled bundle integrity-checked for diagnosis,
        # but its source patch in the verified release is the sole replacement.
        self._verify_review_bundle_registration(hook)
        self._verify_source_replacement(hook, manifest)
        self._verify_required_source_patches(manifest)

    def _verify_required_source_patches(self, manifest: dict):
        if "requiredSourcePatches" not in self.c:
            return
        requirements = self.c["requiredSourcePatches"]
        if not isinstance(requirements, list):
            raise DeployError("Required source patch registration must be a list")
        seen = set()
        for requirement in requirements:
            if not isinstance(requirement, dict):
                raise DeployError("Required source patch registration is invalid")
            self._verify_source_replacement({"sourceReplacement": requirement}, manifest)
            identity = (requirement.get("repository"), requirement.get("number"), requirement.get("head"))
            if identity in seen:
                raise DeployError("Required source patch registration contains a duplicate pin")
            seen.add(identity)

    def _verify_local_hook_files(self, candidate: Path, manifest: dict):
        hooks = self.c.get("hooks", [])
        review_hooks = [hook for hook in hooks if isinstance(hook, dict) and hook.get("kind") == "review-tool-access"]
        if len(review_hooks) != 1:
            raise DeployError("Review-tool source replacement hook is missing or duplicated")
        self._verify_review_bundle_registration(review_hooks[0])
        self._verify_source_replacement(review_hooks[0], manifest)
        self._verify_required_source_patches(manifest)
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

    def _run_migration_precondition_probe(self, old_target: Path, candidate: Path,
                                          manifest: dict, migration_diff: dict, previous: dict):
        hooks = self.c.get("hooks", [])
        probes = [hook for hook in hooks if isinstance(hook, dict) and hook.get("kind") == MIGRATION_PROBE_KIND]
        if len(probes) != 1:
            raise DeployError("A registered migration precondition probe is required for changed migrations")
        probe = probes[0]
        path = Path(probe.get("path", ""))
        if (not path.is_absolute() or probe.get("readOnlyProduction") is not True or
                not isinstance(probe.get("sha256"), str) or not HEX_64.fullmatch(probe["sha256"]) or
                not path.is_file() or hash_file(path) != probe["sha256"]):
            raise DeployError("Registered migration precondition probe is invalid")

        active_fingerprint = self._verify_active_fingerprint(old_target, previous)
        candidate_fingerprint = self._protected_inventory(candidate, manifest["packageMap"].values())
        active_fingerprint_sha = self._inventory_identity(active_fingerprint)
        candidate_manifest_sha = self._manifest_identity(manifest)
        expected = {
            "schemaVersion": MIGRATION_PROBE_SCHEMA,
            "baselineInventorySha256": migration_diff["baselineInventorySha256"],
            "candidateInventorySha256": migration_diff["candidateInventorySha256"],
            "activeFingerprintSha256": active_fingerprint_sha,
            "candidateManifestSha256": candidate_manifest_sha,
            "activePayloadPath": str(old_target),
            "candidatePayloadPath": str(candidate),
        }
        active_receipt = previous.get("patchedRelease") or {}
        production_context = self._production_probe_context(probe)
        expected["productionIdentitySha256"] = self._manifest_identity(production_context)
        context = {**expected, **production_context,
                   "activeProtectedFiles": active_fingerprint,
                   "activeProtectedRoots": active_receipt.get("protectedRoots") or self.c.get("activeRoots") or []}
        # The registered script owns its read-only production query and its
        # isolated migration/boot fixture. The deployer passes only this
        # hash-bound context; it never executes SQL from a release manifest.
        with tempfile.TemporaryDirectory(prefix="paperclip-migration-precondition-") as directory:
            context_path = Path(directory) / "context.json"
            context_path.write_text(self._canonical_json(context) + "\n", encoding="utf-8")
            context_path.chmod(0o600)
            result = self.command(["/usr/bin/node", "--experimental-vm-modules", str(path), str(context_path)],
                                  check=True, capture_output=True, text=True, timeout=180)
        try:
            receipt = _json_bytes((result.stdout or "").encode("utf-8"), "Migration precondition probe result")
        except (AttributeError, UnicodeEncodeError) as exc:
            raise DeployError("Migration precondition probe did not return a valid receipt") from exc
        if (not isinstance(receipt, dict) or type(receipt.get("schemaVersion")) is not int or
                any(receipt.get(key) != value for key, value in expected.items()
                    if key != "activePayloadPath" and key != "candidatePayloadPath")):
            raise DeployError("Migration precondition probe result is not bound to this cutover")
        live = receipt.get("livePreconditions")
        old_boot = receipt.get("oldApplicationBootProof")
        candidate_boot = receipt.get("candidateApplicationBootProof")
        if (not isinstance(live, dict) or live.get("passed") is not True or
                not isinstance(old_boot, dict) or old_boot.get("passed") is not True or
                old_boot.get("databaseInventorySha256") != migration_diff["candidateInventorySha256"] or
                not isinstance(candidate_boot, dict) or candidate_boot.get("passed") is not True or
                candidate_boot.get("databaseInventorySha256") != migration_diff["candidateInventorySha256"]):
            raise DeployError("Migration probe did not prove live preconditions and both runtime boots")
        return receipt

    def _production_probe_context(self, probe: dict):
        # These are locally registered configuration paths, never release data.
        paths = {}
        for key in ("productionConfigPath", "productionEnvFilePath"):
            value = probe.get(key)
            if not isinstance(value, str) or not Path(value).is_absolute():
                raise DeployError("Migration probe production configuration is not registered")
            path = Path(value)
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(self.home.resolve()):
                raise DeployError("Migration probe production configuration is outside the registered home")
            paths[key] = str(path.resolve())
            def identity():
                info = path.stat()
                return [str(value) for value in (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_mode)]
            before = identity()
            digest = hash_file(path)
            if identity() != before:
                raise DeployError("Migration probe production configuration changed while reading")
            paths[key + "Identity"] = {"stat": before, "sha256": digest}
        service = self.c.get("serviceName", "paperclip")
        if not isinstance(service, str) or not re.fullmatch(r"[A-Za-z0-9_.@-]+", service):
            raise DeployError("Migration probe service identity is invalid")
        result = self.command(["systemctl", "show", service, "-p", "MainPID", "--value"],
                              check=True, capture_output=True, text=True, timeout=10)
        pid = (result.stdout or "").strip()
        if not re.fullmatch(r"[1-9][0-9]*", pid):
            raise DeployError("Migration probe requires a running production process")
        return {**paths, "productionServerPid": int(pid), "paperclipHome": str(self.home.resolve()),
                "apiBase": self.api}

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
        owner = drain.get("ownerId") if isinstance(drain, dict) else None
        if not isinstance(owner, str) or not owner.strip():
            raise DeployError("Paperclip did not confirm ownership of the idle drain")
        try:
            status = self.api_json("/instance/task-drain", token=token)
            if (not isinstance(status, dict) or status.get("ownerId") != owner or
                    status.get("draining") is not True):
                raise DeployError("Paperclip did not confirm the acquired idle drain")
            if status.get("activeRuns") != 0 or status.get("pendingWakes") != 0:
                raise DeployError("Work appeared after the idle drain started")
            return owner
        except Exception:
            # The POST may have acquired the lock even when its readback is
            # malformed or belongs to a different owner. Release only the
            # exact owner returned by our POST, and preserve the readback error.
            with contextlib.suppress(Exception):
                self.release_drain(token, owner)
            raise

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
        try:
            self.api_json("/instance/task-drain?ownerId=" + urllib.parse.quote(owner, safe=""), "DELETE", token=token)
        except DeployError as exc:
            # The lease is process-local. A successful restart can remove it
            # before cleanup, so the old owner receives a conflict. Only an
            # explicit unowned, inactive readback proves cleanup is complete.
            cause = exc.__cause__
            if not isinstance(cause, urllib.error.HTTPError) or cause.code != 409:
                raise
            status = self.api_json("/instance/task-drain", token=token)
            if isinstance(status, dict) and status.get("draining") is False and status.get("ownerId") is None:
                return
            raise

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
            if os.name != "nt":
                raise
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
        migration_probe_receipt = None
        try:
            has_migration_changes = any(migration_diff.get(key) for key in ("added", "changed", "removed"))
            if has_migration_changes:
                fresh_diff = self._migration_diff(old_target, candidate, manifest)
                if (fresh_diff.get("baselineInventorySha256") != migration_diff.get("baselineInventorySha256") or
                        fresh_diff.get("candidateInventorySha256") != migration_diff.get("candidateInventorySha256") or
                        fresh_diff.get("compatibility", {}).get("status") != "needsRuntimeCompatibility" or
                        fresh_diff.get("compatibility", {}).get("manifestSha256") !=
                        migration_diff.get("compatibility", {}).get("manifestSha256")):
                    raise DeployError("Migration compatibility proof changed after candidate staging")
            self._verify_registered_support_files()
            self._verify_local_hook_files(candidate, manifest)
            self._verify_runner_release_assets(candidate, manifest)
            self.assert_no_work(token)
            owner = self.start_drain(token)
            self.verify_owned_drain(token, owner)
            # Recheck the old active package's migration baseline immediately
            # before switching; a concurrent manual update must defer this run.
            if self.current_link.resolve(strict=True) != old_target:
                raise DeployError("Active Paperclip payload changed during staging")
            active_migrations = _file_inventory(old_target, MIGRATION_ROOT.rstrip("/"))
            if (str(old_target) != migration_diff.get("baselinePath") or
                    active_migrations != migration_diff.get("baselineInventory")):
                raise DeployError("Active migration baseline changed after candidate staging")
            candidate_migrations = _file_inventory(candidate, MIGRATION_ROOT.rstrip("/"))
            if candidate_migrations != migration_diff.get("inventory"):
                raise DeployError("Candidate migration inventory changed after staging")
            self.verify_owned_drain(token, owner)
            self._verify_registered_support_files()
            self._verify_local_hook_files(candidate, manifest)
            self._verify_runner_release_assets(candidate, manifest)
            if has_migration_changes:
                self._verify_owned_candidate(candidate, manifest)
                migration_probe_receipt = self._run_migration_precondition_probe(old_target, candidate, manifest, migration_diff, previous)
                self._verify_owned_candidate(candidate, manifest)
            # The probe runs immediately before cutover. Repeat the active and
            # candidate inventory CAS after it to close any concurrent-change
            # window while still holding the owned drain.
            if self.current_link.resolve(strict=True) != old_target:
                raise DeployError("Active Paperclip payload changed during migration precondition check")
            self._verify_active_fingerprint(old_target, previous)
            if (_file_inventory(old_target, MIGRATION_ROOT.rstrip("/")) != migration_diff.get("baselineInventory") or
                    _file_inventory(candidate, MIGRATION_ROOT.rstrip("/")) != migration_diff.get("inventory")):
                raise DeployError("Migration inventory changed during precondition check")
            self.verify_owned_drain(token, owner)
            if migration_probe_receipt is not None:
                probe = next(hook for hook in self.c["hooks"] if hook.get("kind") == MIGRATION_PROBE_KIND)
                if (self._manifest_identity(self._production_probe_context(probe)) !=
                        migration_probe_receipt.get("productionIdentitySha256")):
                    raise DeployError("Production configuration or process changed during migration precondition check")
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
        # Authenticated instances intentionally redact the version from public
        # health. Use the same existing operator identity as the drain checks.
        token = self.load_token()
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            try:
                data = self.api_json("/health", token=token)
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

    def _active_install_identity(self):
        install = self._read_install()
        current = self.current_link.resolve(strict=True)
        payload = install.get("payloadPath")
        if not isinstance(payload, str) or Path(payload).resolve(strict=True) != current:
            raise DeployError("Active symlink and install manifest disagree")
        receipt = install.get("patchedRelease") or {}
        version = install.get("version")
        commit = receipt.get("patchedCommit")
        if (not isinstance(version, str) or not version or not isinstance(commit, str) or
                not re.fullmatch(r"[0-9a-f]{40}", commit)):
            raise DeployError("Active install has no exact version and patched-commit identity")
        return (str(current), version, commit)

    def _verify_active_for_prune(self, expected_version: str):
        self._active_health_verified_identity = None
        before = self._active_install_identity()
        self._verify_active(expected_version)
        after = self._active_install_identity()
        if before != after:
            raise DeployError("Active install changed during health verification")
        self._active_health_verified_identity = after

    def run(self, mode="check"):
        install = self._read_install()
        current = self.current_link.resolve(strict=True)
        self._verify_active_fingerprint(current, install)
        self._active_health_verified_identity = None
        if self.retained_inactive_candidates == 0:
            # Health must attest the install manifest's version and patched
            # commit before recorded rollback payloads become eligible for
            # retention cleanup. A failed/unavailable health read is fail-safe:
            # keep history and continue through the existing update path.
            try:
                self._verify_active_for_prune(install.get("version"))
            except Exception:
                self._active_health_verified_identity = None
        try:
            release, manifest, assets = self.find_release()
        except DeployError as exc:
            if "No patched Canary release is published" in str(exc) or isinstance(exc, ReleaseNotReady):
                self._write_status({"state": "waiting", "reason": "No verified green public fork release is available"})
                return {"available": False, "state": "waiting"}
            raise
        manifest = dict(manifest)
        manifest["tag"] = release["tag_name"]
        current_tag = (install.get("patchedRelease") or {}).get("tag")
        if current_tag == release["tag_name"]:
            if self.retained_inactive_candidates == 0:
                stem = f"{manifest['version']}-patched-{manifest['runId']}-{manifest['runAttempt']}"
                target = self.installs / stem
                reusable_target = target if target.is_dir() and not target.is_symlink() else None
                self._prune_owned_candidates(reusable_target)
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
        if self.retained_inactive_candidates == 0:
            # activate() returned only after candidate health verification and
            # its rollback window closed. Preserve the active target; release
            # older history payloads while retaining their install metadata.
            try:
                self._verify_active_for_prune(manifest["version"])
            except Exception:
                self._active_health_verified_identity = None
            self._prune_owned_candidates(candidate)
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
        deployer = Deployer(config)
        with deployer.deployment_lock():
            result = deployer.run("run" if args.run else "stage" if args.stage else "check")
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
