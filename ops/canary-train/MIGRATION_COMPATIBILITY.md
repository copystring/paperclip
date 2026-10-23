# Isolated migration compatibility lane

Run the migration fixture from a built candidate checkout, never against the configured production database:

```sh
node ops/canary-train/verify-migration-compatibility.mjs /path/to/candidate/packages/db /tmp/migration-compat-receipt.json
```

The lane downloads the pinned Canary 6 database package, verifies its exact npm SRI and its 354-file inventory against the reviewed 0354 hash. It requires the candidate to preserve every old SQL migration byte-for-byte and extend the old journal by exactly 19 SQL migrations. It creates a disposable embedded PostgreSQL cluster, applies the old package's real migration engine, inserts a representative company/agent/task-retry wakeup and company/user/agent-owned instance secret metadata, then applies the candidate package's real migration engine. It writes a receipt only after the migration journal, preserved rows, retry index, and secret-scope schema/data checks pass. A failed run removes the temporary cluster and emits no receipt. The output receipt binds the old package identity and the old/candidate migration-inventory and journal hashes.

This receipt is evidence for this exact migration-path test only. It does not establish that the old Paperclip application can boot against the migrated schema or roll back safely, and it must not be used as a consumer allowlist until the separate old-application boot/rollback lane passes.
