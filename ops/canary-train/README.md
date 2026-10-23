# Canary patch train build controller

This controller assembles the official synchronized npm canary source with only the reviewed, manifest-pinned pull requests, builds it using the upstream release toolchain, and emits a hash-indexed runtime overlay. The build primitive only produces verified runtime files; the workflow publishes a green release through `publish.py`, and the instance consumer activates it after its local compatibility and idle checks.

## Commands

Run from the repository root with Python 3.10 or newer, Git, Node, pnpm, and the upstream native build prerequisites installed. The workspace and output directories must be unique to the run.

```sh
python3 ops/canary-train/build.py prepare \
  --manifest ops/canary-train/patches.json \
  --workspace "$RUNNER_TEMP/canary-source" \
  --output "$RUNNER_TEMP/canary-output"
python3 ops/canary-train/build.py build \
  --test-receipts "$RUNNER_TEMP/canary-test-receipts" \
  --runner-artifacts "$RUNNER_TEMP/canary-runner-artifacts" \
  --provider-pack "$RUNNER_TEMP/canary-provider-pack/provider-pack.json" \
  --workspace "$RUNNER_TEMP/canary-source" \
  --output "$RUNNER_TEMP/canary-output"
python3 ops/canary-train/build.py package \
  --workspace "$RUNNER_TEMP/canary-source" \
  --output "$RUNNER_TEMP/canary-output"
```

`prepare` resolves the synchronized canary tags for `paperclipai` and `@paperclipai/server`, downloads and checks each npm tarball against its registry SRI, and reads the exact source SHA only from the server package's `dist/build-info.json`. It checks out that upstream commit, applies only the exact pinned PR heads in the manifest, then commits `.canary-train.json` with a final subject beginning `canary-train:`. A PR is skipped only when its merge commit is already an ancestor of the source or its exact diff reverse-applies. If normal apply fails, it fetches and verifies the exact PR head, then tries Git's blob-verified three-way merge. Any unresolved conflict stops the train. A reviewed integration patch may be supplied per PR in the controller manifest with a repository-relative path and SHA256; it is considered only after a three-way conflict, must apply cleanly, and must touch exactly the PR's API-verified paths. Conflicts are restored only for those paths before the pinned integration diff is considered. Changed pins, incomplete file listings, package metadata changes, dependency changes, and source drift stop the run.

`build` runs the frozen pnpm install, workspace typecheck, workspace build, upstream public-package build primitive, and server UI preparation. The complete test matrix and four native daemon builds run in separate jobs from the same SHA-verified prepared source. Native jobs build on the matching Linux/macOS and x64/arm64 hosts; the Linux x64 job also builds the remote provider pack into `$RUNNER_TEMP`, outside the source checkout. The final build calls upstream's `stage-release-runner-binaries.mjs assemble-daemons` verifier with all four source-bound receipts, then copies the verified daemon and provider-pack outputs into the server runtime. No published npm binaries are transplanted over patched TypeScript. GitHub tokens are removed from the environment for all candidate build and test commands. No mutable dependency-install fallback is used.

The hosted workflow freezes one prepared source archive and records its SHA256 in the assembly job outputs. Test, native and build jobs verify that digest before extracting the same source and Git commit. `plan` uses the upstream wrapper's dry-run inventory to validate the full test partition: four general-server shards, all three workspace groups, and two serialized-route shards. The general-server group retains native runner tests. Lanes containing tests that build or require local Runner binaries prepare the upstream debug and release binaries before running the test wrapper, so a cold Rust build does not consume a test hook's timeout. Nine isolated test jobs run these lanes with the upstream wrapper and frozen dependencies; they do not share mutable workspaces. Four additional host-matched jobs build the release daemon for `linux-x64`, `linux-arm64`, `darwin-x64` and `darwin-arm64`; their upstream receipts bind architecture, build metadata, binary digest and exact patched commit. The Linux x64 job generates the provider pack from the same patched TypeScript source, with output kept outside the source tree.

Scheduled and manually dispatched trusted master runs cache only dependency data: the pnpm store is keyed from the prepared Canary lockfile, and Rust dependencies use the prepared source's pinned toolchain and lockfile. PR/controller checks do not read or write these caches. Test results, source build outputs, workspace crates, and Rust binaries are never cached, so every run still performs the complete install, test matrix, typecheck, and build.

Each successful test lane emits a receipt bound to its exact source/patch commit, tree, test plan and lane. `build --test-receipts DIR --runner-artifacts DIR --provider-pack FILE` requires the complete matching test receipt set and all four native artifacts plus the patched-source provider pack before treating quality gates as passed. Missing, duplicate, negative, altered or stale receipts block packaging. Upstream's daemon assembler and provider-pack verifier validate target architecture, daemon build metadata and source identity. This avoids repeating the same full suite in the final build job. Without test receipts, the local full-build command still executes `pnpm test:run`, but still requires complete native artifacts. Intermediate source and receipt artifacts contain public code and CI evidence only and expire after one day; production data and credentials are never copied to CI.

`package` requires the exact immutable prepared commit and green build receipt. It emits `payload.tar.gz` and `manifest.json`; the payload includes the dependency closure of the `paperclipai` and `@paperclipai/server` production packages, not unrelated packages merely published by the monorepo. A pinned patch that changes another published package fails closed rather than silently omitting its runtime changes. The payload contains complete runtime directory roots and exact single-file runtime assets under `node_modules/`, with no package manifests. `packageMap` names every full directory replacement root or exact single-file root, while `files` contains the SHA256 for every archived file. The deployer should validate the archive against both maps, extract into a staging install, and replace each named root as a whole or each exact file so removed outputs cannot remain stale. Migration inventory paths are candidate-install paths under `node_modules/@paperclipai/db/dist/migrations/`, including SQL and JSON journal/snapshot files that are present.

The three packages that receive canonical repository skills in the upstream release script read that same tree directly during packaging. The controller does not create publish staging directories in the prepared source. Both tracked source changes and unexpected untracked files still block the build and package checks.

Cursor, Gemini and OpenCode list an absent `skills` directory in their npm `files` allowlist. npm omits those optional paths, and the controller permits this only for these three known-empty layouts. Other adapter-specific skills remain required, so deleting the last skill cannot leave stale npm content in the candidate. The canonical skills required by the release script and all declared compiled runtime outputs remain required.

The empty-layout check also reads the exact published source commit. If a future Canary has skills for one of those three adapters, a patch that removes them stops the train. Directory names alone cannot authorize omitting previously shipped skills.

The manifest records the official npm version and tarball digests, exact upstream and patched commits/trees, pinned PR heads and outcomes, package-map inventory, archive digest, compiled migration digests, and quality-gate results. The workflow may add its run ID, attempt, controller commit, and workflow reference before publication. Production credentials and private settings do not belong in the artifact.

### Current source integration

The maintained input now includes the modular MCP port (fork PR #22), native
guidance and its regenerated Copilot profile identity (fork PR #24), and the
complete autonomy source port on the assembled prefix (fork PR #25). Their
exact reviewed heads remain in `patches.json`. The original autonomy source
PR #21 remains lineage, rather than a second overlapping source input.

The earlier upstream PR #16723 only refreshed generated capability anchors for
an older skill source. Its independent pin is retired: PR #25 regenerates those
inventories from the actual resulting skill through upstream generator functions.
Both upstream capability checks must still pass in the final build. Old anchor
values are not copied into a newer source tree.

Compatibility diffs for PRs #16520, #16678, #8, #11 and #17018 retain the exact
GitHub-verified original PR file sets. PR #19 retains an independently reviewed
compatibility diff as a fail-closed fallback. Normal verified application is
preferred when it succeeds. No changed-path exception or dirty-source packaging
bypass is introduced. PR #25 is based on the assembled prefix so changes already
owned by earlier source inputs need no artificial no-op edits.

A local authoring preflight against a named published package is not a build,
release receipt, or authorization to use a mismatched CLI/server pair. The
production workflow continues to resolve synchronized current Canary tags,
verify the npm integrity/source identity, and require its complete immutable
Linux test/build/package evidence before publication.

## Instance consumer

`deploy.py` is a standalone service-account executable. Keeping release validation, ownership checks, the idle hold, cutover, and rollback in one auditable file allows the instance to pin and atomically install a single consumer without importing unverified updater code from a candidate. Its regression tests cover partial cutover failures, rejected restarts, retry idempotency, migration drift, and file ownership boundaries.

An instance timer polls the public fork for a completed successful workflow release. It retains existing local settings through hash-pinned service-owned hooks. It never needs a GitHub write token, provider credentials from CI, or extra database backups. New or changed migrations defer activation for a separate compatibility review. Active tasks, queued runs, or an unsafe idle report also defer activation. Old generated candidates are pruned only when their ownership receipt proves they belong to this controller. By default, the active payload, recorded installation history, and three newest owned candidates are retained. An instance may set `retainedInactiveCandidates` to a non-negative integer; `0` removes inactive owned payloads after the active install passes its exact version and patched-commit health readback. If health cannot be verified, history stays available for rollback. Install-history metadata is retained, and the exact candidate already staged for reuse is protected during pruning. The default check mode never removes runtime payloads.

The registered patch set includes the original recovery/UI fixes, the installed 27-commit source series, and the newer OpenCode/MCP/discovery/catalog fixes. Compatibility integration diffs are pinned alongside their original PR heads; each diff must match the API-verified file inventory. The source-series input is a frozen fork PR against its original base, rather than a compiled runtime overlay. New fixes for interactions between these inputs use a separate frozen source PR based on the assembled source. Every input head and integration diff remains explicitly pinned. Later upstream PR revisions require a reviewed head update. The normal PR file inventory covers the new production and test paths; no extra path exceptions are permitted.

The `review-tool-access` instance registration requires `sourceReplacement` with the exact `repository`, `number` and `head` of the reviewed source-series PR. Its historical script and bundle remain hash-checked but are never executed on the new runtime. The verified release must prove that source patch was applied or is already part of the published source. This proof is checked again on reuse and before cutover. An optional `requiredSourcePatches` list can pin additional source patches using the same exact `{repository, number, head}` shape. When configured, each pin must have exactly one accepted proof in the release patch inventory; malformed, duplicate, changed, or absent pins reject the candidate during hook application, candidate reuse, and preactivation. Omitting this setting preserves existing instance configurations. Private Codex authentication and instruction-policy hooks, plus the independent tool-error probe, remain required.

The controller workflow runs once daily at 03:23 UTC; identical green builds are skipped. The instance timer template checks once daily at 08:30 UTC, with up to 40 seconds of random delay. It catches up once after downtime. Manual checks remain available. Install the timer template only after the first accepted activation; retain the existing service and its configuration. PR heads remain pinned until deliberately reviewed. A patch is retired automatically when the exact published Canary includes its merged commit or already contains the verified patch. A changed unreviewed PR head or unresolved source conflict blocks publication.

### Reviewed migration transitions

Changed migration inventories remain blocked by default. A local
`approvedMigrationTransitions` entry must name the exact baseline and candidate
inventory hashes and a nonempty `requiredAssertions` list. The release must
contain a matching `migrationCompatibilityReceipt` from its verified successful
workflow, including the installed baseline package version and npm integrity.
The receipt is bound to the workflow run, attempt, controller, source and patched
commit. Approval alone cannot substitute for that evidence.

Before cutover, a hash-registered `migration-precondition-probe` hook must prove
live preconditions and both exact application starts against an isolated,
migrated fixture. Its registration must set `readOnlyProduction: true` and name
`productionConfigPath` and `productionEnvFilePath` as regular files inside the
registered Paperclip home. The consumer obtains the running process ID from
the configured systemd service. It passes these paths, the loopback API base,
payload paths and receipt hashes in a private temporary context file. It does
not put credentials in command arguments. The probe may write its isolated
fixture; it must not migrate, copy or modify the production database.

The consumer rechecks candidate integrity, active files, migration inventories
and drain ownership after the probe. Missing or failed evidence defers the
update before it changes the active symlink. Existing backup and service
settings are not modified by this compatibility mechanism.

### Manifest-aware preservation probes

A registered `tool-review-probe` can set `verifiedReleaseManifest: true`.
The consumer then requires its configured source pins to pass before it runs
the probe. It passes the same accepted release manifest as one extra path
argument after `patched`. The private temporary file is outside the payload
and is removed on success or failure. Existing probes keep their original
arguments when the option is absent. Invalid non-boolean options fail closed.

This lets a source-integrated preservation probe use the verified CI file
inventory and its existing behavior tests instead of fixed compiled hashes
from an older installation. It does not authorize trusting a synthetic
manifest or removing private policy, support-file, package, or source checks.

## Local checks

```sh
python3 -m py_compile ops/canary-train/build.py
python3 -m unittest discover -s ops/canary-train -p 'test_*.py' -v
```
