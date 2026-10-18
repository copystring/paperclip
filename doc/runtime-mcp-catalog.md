# Runtime MCP tool discovery

Server-owned assigned MCP runtime URLs use `?catalog=on-demand`. This is a
presentation mode, not an additional grant. The URL is part of the adapter's
MCP session identity. Ordinary named-gateway clients without this opt-in retain
their direct tools and schemas. Native assigned-tool projections that call the
gateway service directly retain their own catalog contract.

In this mode, MCP `tools/list` authorizes the existing listing and exposes
`paperclip_search_tools` and `paperclip_call_tool`, alongside the existing four
resource/prompt helpers. A small app/action name index makes nested discovery
actions visible before the first search, without eagerly including their schemas.
If the complete index exceeds 12 KiB, it uses complete app counts or a browse
hint; all names remain searchable. Search accepts tool/application names, upstream
action names and descriptions; exact action names rank ahead of mentions;
an empty query browses. It returns exact original names, risk metadata,
approval descriptions and complete parameter schemas only for matching results.
An upstream discovery gateway is still a gateway: first discover its own search
tool, then use that tool's documented search and call routes.

Follow every returned page/reference needed for the selected operation. Large
schemas and text fields are available in Unicode code-point chunks with hashes;
pass the reference's `expectedHash` when continuing. A changed value returns 409
instead of silently combining revisions. No schema or instruction is truncated.

Search and schema/text retrieval reload the authorized catalog on every request.
Search requires the token's `tools/list` and `tools/call` actions. The call wrapper
uses the original `executeTool` path once: it resolves the exact current target,
validates arguments against that tool's schema without coercion, defaults or
property removal, before projecting server-managed provider fields. Policy still
evaluates the actual governed arguments used for execution.
Listing visibility with empty arguments is not an execution permission gate.
Each incoming call consumes the normal protocol limits once. Run/company/identity,
current grants, profiles, work-mode policy, approvals, invocation auditing and
provider error handling remain authoritative. Discovery never authorizes execution.
Direct application names are rejected in the opted-in projection; existing
resource/prompt helpers keep their own context-method permission checks.

Tests: `mcp-tool-catalog.test.ts` covers complete pagination, bounded Unicode
schema/text reconstruction, revision changes and input validation;
`mcp-tool-catalog-http.test.ts` covers protocol projection and exact dispatch;
`tool-gateway-discovery-http.test.ts` exercises real PostgreSQL-backed listing,
policy revocation, token revocation and token-action restrictions in both modes.
Runtime delivery and ACP identity tests cover the opt-in URL and fingerprint.

Measure total model turns and actual input/cache usage, not only catalog bytes:
on-demand discovery may add a model round while reducing every subsequent
request's schema payload. Request and token reductions are not quota percentages.
