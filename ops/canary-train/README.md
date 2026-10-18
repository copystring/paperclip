# Canary patch train build controller

This controller assembles the official synchronized npm canary source with only the reviewed, manifest-pinned pull requests, builds it using the upstream release toolchain, and emits a hash-indexed runtime overlay. It does not publish or deploy anything.

## Commands

Run from the repository root with Python 3.10 or newer, Git, Node, pnpm, and the upstream native build prerequisites installed. The workspace and output directories must be unique to the run.

```sh
python3 ops/canary-train/build.py prepare \
  --manifest ops/canary-train/patches.json \
  --workspace "$RUNNER_TEMP/canary-source" \
  --output "$RUNNER_TEMP/canary-output"
python3 ops/canary-train/build.py build \
  --workspace "$RUNNER_TEMP/canary-source" \
  --output "$RUNNER_TEMP/canary-output"
python3 ops/canary-train/build.py package \
  --workspace "$RUNNER_TEMP/canary-source" \
  --output "$RUNNER_TEMP/canary-output"
```

`prepare` resolves the synchronized canary tags for `paperclipai` and `@paperclipai/server`, downloads and checks each npm tarball against its registry SRI, and reads the exact source SHA only from the server package's `dist/build-info.json`. It checks out that upstream commit, applies only the exact pinned PR heads in the manifest, then commits `.canary-train.json` with a final subject beginning `canary-train:`. A PR is skipped only when its merge commit is already an ancestor of the source or its exact diff reverse-applies. If normal apply fails, it fetches and verifies the exact PR head, then tries Git's blob-verified three-way merge. Any unresolved conflict stops the train. A reviewed integration patch may be supplied per PR in the controller manifest with a repository-relative path and SHA256; it is considered only after a three-way conflict, must apply cleanly, and must touch exactly the PR's API-verified paths. Conflicts are restored only for those paths before the pinned integration diff is considered. Changed pins, incomplete file listings, package metadata changes, dependency changes, and source drift stop the run.

`build` runs the frozen pnpm install, workspace typecheck and tests, workspace build, upstream public-package build primitive, and server UI preparation. GitHub tokens are removed from the environment for all candidate build and test commands. No mutable dependency-install fallback is used.

`package` requires the exact immutable prepared commit and green build receipt. It emits `payload.tar.gz` and `manifest.json`; the payload includes the dependency closure of the `paperclipai` and `@paperclipai/server` production packages, not unrelated packages merely published by the monorepo. A pinned patch that changes another published package fails closed rather than silently omitting its runtime changes. The payload contains complete runtime directory roots and exact single-file runtime assets under `node_modules/`, with no package manifests. `packageMap` names every full directory replacement root or exact single-file root, while `files` contains the SHA256 for every archived file. The deployer should validate the archive against both maps, extract into a staging install, and replace each named root as a whole or each exact file so removed outputs cannot remain stale. Migration inventory paths are candidate-install paths under `node_modules/@paperclipai/db/dist/migrations/`, including SQL and JSON journal/snapshot files that are present.

The manifest records the official npm version and tarball digests, exact upstream and patched commits/trees, pinned PR heads and outcomes, package-map inventory, archive digest, compiled migration digests, and quality-gate results. The workflow may add its run ID, attempt, controller commit, and workflow reference before publication. Production credentials and private settings do not belong in the artifact.

## Instance consumer

`deploy.py` is a standalone service-account executable. Keeping release validation, ownership checks, the idle hold, cutover, and rollback in one auditable file allows the instance to pin and atomically install a single consumer without importing unverified updater code from a candidate. Its regression tests cover partial cutover failures, rejected restarts, retry idempotency, migration drift, and file ownership boundaries.

An instance timer polls the public fork for a completed successful workflow release. It retains existing local settings through hash-pinned service-owned hooks. It never needs a GitHub write token, provider credentials from CI, or extra database backups. New or changed migrations defer activation for a separate compatibility review. Active tasks, queued runs, or an unsafe idle report also defer activation. Old generated candidates are pruned only when their ownership receipt proves they belong to this controller; the active payload and recorded installation history are retained.

The controller workflow runs hourly; identical green builds are skipped. PR heads remain pinned until deliberately reviewed. A patch is retired automatically when the exact published Canary includes its merged commit or already contains the verified patch. A changed unreviewed PR head or unresolved source conflict blocks publication.

## Local checks

```sh
python3 -m py_compile ops/canary-train/build.py
python3 -m unittest discover -s ops/canary-train -p 'test_*.py' -v
```
