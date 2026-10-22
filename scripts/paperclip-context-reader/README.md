# Bounded Paperclip context delivery

The reader fetches one current issue document or one identified comment using the existing run's API credentials. It emits unchanged body text in numbered JSON pages, each at most 8 KiB including metadata. Reconstructing every page yields the exact source body and SHA-256. No model call or remote mutation is performed.

```sh
node read-context.mjs fetch --document ISSUE/KEY
node read-context.mjs fetch --comment ISSUE/COMMENT_UUID
node read-context.mjs read --manifest RETURNED_PATH --page NEXT_PAGE
node --test read-context.test.mjs
```

Read every page from zero through `totalPages - 1`; `lastPage` describes the returned page, not whether earlier pages were read. Fetch creates private source files in the current workspace, bound to the current run ID. A different run must fetch current sources. Source revisions and hashes provide identity, not proof that a model read the content. Existing permissions, review requirements and source trust remain unchanged.

`verify-skill-aliases.mjs` checks deployment-owned aliases against their declared stable runtime target. It reports drift without rewriting links or replacing external skills. The deployment operator supplies the owned alias inventory. It is chained after existing update checks in the live installation.
