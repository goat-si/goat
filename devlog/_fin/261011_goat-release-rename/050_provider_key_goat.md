# 050 — wp6: provider MCP registration key `goat`

> **Audit fold (cycle 3)** — OpenCode 2 hashes the original thread id whenever sanitization is lossy (`sanitized !== threadId`) OR the prefixed name exceeds 64 characters. The exact 59-character collision pair (`thread:` + 49 `x` + `a:b` / `a_b`) now has a replay regression proving distinct HTTP registrations and symmetric removal. Existing lossy-id permission/test/fixture expectations are amended together; the own-thread wildcard overlap remains a pre-existing follow-up below. Source builds/tests were not run.

> **Stale check @f08a410af** — amended-hunk count: **11** (8 stale before-images, 3 line-position refreshes). The previous stale-check pass rechecked **182 hunks / 83 files** against the current wp2/wp3 source; cycle 3 refreshes the five existing OpenCode source/test/fixture diff blocks and revalidates all final hunk before-images read-only. Source builds/tests were not run.

## Loop spec

- Archetype: satisfy-spec, bounded provider integration work-phase. Parent owns all PABCD/FSM/loop/goal transitions and consultation; this leaf writes a plan only.
- Trigger: D6/A12 in `000_plan.md` and `002_architect.md`, after wp3 and before wp4, renames agent-visible MCP registration from `t3-code` to `goat`.
- Goal: new Codex, Cursor, Muse, ACP (including Grok/Antigravity), OpenCode 1/2, Pi and Claude sessions discover/call GOAT tools under the correct provider namespace, with unchanged credential/permission boundaries and readable old history.
- Non-goals: releases, CLI/archive/state-directory changes, env or npm/package renames, provider process restarts, browser/SSH execution, database rewrites, broad product rebranding, changing MCP wire tools owned by wp3, migrating saved Pi loadouts, installing dependencies, running builds/tests/servers during this plan-only delegation, source writes or git operations by this leaf.
- Verifier: focused commands in §6, all NOT RUN (explicit delegated restriction); source/config existence and hunk preimages inspected read-only. Runtime acceptance is registration + executable tool call, discovery/permission semantics, ACP origin precedence, OpenCode thread isolation and history rendering. Local source inspection is not PASS evidence for these behaviors.
- Stop: leaf stops after this complete single-file plan and handoff. Parent stops implementation when all focused gates pass on final integrated wp3/wp6 source and independent review passes, or records NEEDS_HUMAN for a policy/compatibility decision.
- Memory artifact: `devlog/_fin/261011_goat-release-rename/050_provider_key_goat.md`; parent places later command evidence in the existing unit evidence directory. This leaf creates no other artifacts.
- Outcomes: PLAN_WRITTEN (this delegation); implementation DONE (fresh gates/review), NEEDS_HUMAN (loadout/legacy-runtime compatibility decision), BLOCKED (missing toolchain). These are report dispositions, not new FSM states.
- Escalation: need for dual runtime registration, existing-process reload, broader identity migration, unplanned provider contract change, stale hunk ambiguity, or source outside the listed file map. Do not silently broaden scope.

## 1. Source and integration preconditions

Source root: `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename`. Paths below are exact relative paths under this root, never under the plan checkout. Before-images were refreshed against current source on 2026-10-11; read-only `git rev-parse HEAD` returned `f08a410af0fa854b4c38fb7ed59bfc65424855c4`. This includes wp2 release/probe work at `fe8df0d3a` and wp3 bare MCP tools, GOAT server identity, shared aliases and ContextHandoffDelivery legacy rewriting at `f08a410af`. The original planning pass read `000_plan.md`, `001_inventory.md`, AGENTS.md and `docs/internals/effect-services.md`; this stale-check pass re-read every mapped source file and affected package test recipe. Existing wp3 source is now the authority for bare tool names.

All files are MODIFY; no source files are NEW or DELETE. The only actual leaf write is this plan. This is a diff specification against the inspected wp2/wp3 source at `f08a410af`, not proof that changes were applied. The refreshed hunks preserve toolkit renames, shared inventory aliases, CLI comments and docs. Claude keeps all current `goat_*` bare ids and changes their namespace to `mcp__goat__goat_*`; shared reader hunks retain `T3_MCP_TOOL_NAMES` and the complete legacy alias map. Recheck before-images if HEAD or mapped source bytes change again; do not undo wp3 when resolving context. A hunk failure requires a refreshed plan, not `--reject`, blanket replacements or forcing a patch.

The creation/serialization/consumption chain is: provider-local config object / ACP server list / Pi extension registration → SDK or ACP wire / OpenCode `mcp.add` → provider-qualified event names / ACP metadata → runtimeModel + shared presentation readers + Claude preapproval matching. Endpoint and token issuance are unchanged. This is a free string registration key, not a new enum or persisted field. Old history remains a reader concern. No new Effect service or transport logic is needed; adapters already own the registration boundary and helpers stay pure. Do not move ownership into ws.ts/HTTP/MCP handlers.

Consultation: inherited parent-owned `002_architect.md` process; no child spawn grant was supplied to this leaf and no consultation is claimed here. Parent must send the final integrated document to the same architect for reflection and then perform independent A review.

## 2. Ordered steps and decisions

Execution order (A12): **wp2 → wp3 → wp6 → wp4 → wp5**. wp6 runs after wp3 and before wp4. Complete its registration/allowlist/history changes before wp4 builds the runtime; wp5 then uses a fresh provider session to discover and call the final `mcp__goat__goat_*` names. The remote probe must not precede this cutover.

1. Revalidate wp3: all 42 renamed bare tools exist as `goat_*`; shared readers retain `t3_*` history aliases. Do not duplicate toolkit definitions. At `f08a410af`, source inspection cross-checked the planned 19 Claude read-only ids against the seven toolkit groups used by its existing annotation test: 15 have `mcp__goat__goat_*` names; `orchestrator_capabilities`, `list_scheduled_tasks`, `html_preview` and `html_render` retain their bare names under `mcp__goat__`. Run that test after implementation.
2. Extend shared reader namespace recognition with goat while retaining historical t3-code/t3_code/t3code spellings and icon/logo identifiers. This prerequisite prevents newly registered calls losing product/HTML presentation.
3. Update provider registrations: Codex config, Cursor/Muse SDK objects, shared ACP stdio + MCP-over-ACP lists and bridge serverId, OpenCode 1's isolated managed-server entry. With no provider-session credential, inject no MCP server. OpenCode external-server path stays externally owned.
4. Update ACP recovery prefix/suffix regexes, known-tool inventory matching and all origin guards together. Canonical GOAT recovery returns `server: "goat"`; explicit foreign raw/meta origins keep their identity. Unknown/path-like GOAT names stay generic. ACP Grok and Antigravity use this same adapter; their separate auth/probe/text-only clientInfo names are not registrations and do not need changing.
5. Update OpenCode 2 directory-level per-thread namespace to `goat-<thread>` only when sanitization is lossless and the prefixed name fits 64 characters. Use the existing SHA-256 first-16-hex digest of the raw id whenever `sanitized !== threadId` OR the prefixed name exceeds 64, independent of prefix length. Fold the exact `thread:` + 49 `x` + `a:b` / `a_b` regression into the existing HTTP replay harness, checking distinct registered names, scoped credentials and same-name removal. Update existing lossy-id permission expectations (including forks and adapted replay fixtures) to their raw-id digest names. Deny legacy `t3-code-*` AND current `goat-*`, then allow `${ownServer}_*`. Rules remain after broad runtime grants and agent path rules so the last matching rule preserves isolation. Keep register/remove symmetry and fork-specific credentials. Update app-owned instruction entry key to `goat` along with replay expectations; do not modify provider's unrelated settings.
6. Pi registers one `mcp__goat__<bare-tool>` per catalog item on modern and legacy Pi. Do NOT map two prefixes onto the same name. Keep bridge registration before builtins, direct orchestration tools, optional deferred discovery, tree-loadout reconciliation, cancellation and request metadata. Saved loadouts/selectors with old qualified names must be edited by their owner; no write-side old aliases are added.
7. Claude registers `goat`, uses `mcp__goat__*` only for non-read-only sessions, and read-only allowlist uses `mcp__goat__goat_*` for renamed tools plus unchanged non-t3 tools. Leave symbolic export names and auth env unchanged. Existing explicit allowlists are not rewritten automatically. Annotation cross-check must pass; never replace read-only list with a wildcard.
8. Correct the existing provider/user instruction strings and documentation. Preserve wrapper/context keys such as `t3_code_instructions` and `t3_code_orchestration` (they are application context identifiers, not registrations). Adapt replay fixture inputs explicitly as below; record them as adapted fixtures, not fresh captures.
9. Run §6 focused commands after implementation, inspect the allowed leftovers, request final independent review, and record exact evidence in the parent's unit. Hand the verified namespace to wp4 before the wp5 probe of final `mcp__goat__goat_*` names. No live service restart is required or authorized by this document.

Compatibility decision: D6 is a fresh-session registration cutover. Legacy namespace recognition (`t3-code`, `t3_code`, `t3code`) and bare `t3_*` aliases remain exclusively on the read side for history/presentation; no legacy namespace is registered, approved, or exposed as an executable alias. The OpenCode legacy deny rule is a rejection boundary, not a compatibility registration. Existing ContextHandoffDelivery legacy rewriting from wp3 is preserved. An old active provider process or Pi loadout can still address the old key; do not claim live migration. OpenCode old entries are denied rather than reused. ACP explicit legacy origins can still be projected as foreign MCP identity; shared readers render historical qualified names. Bare ACP fallback identity becomes goat because the app owns that bridge invocation.

## Residual (pre-existing, out of scope)

The own-thread allow wildcard `goat-thread_<id>_*` can also match a foreign thread whose readable id extends the owner's id with `_`: for lossless ids `thread_owner` and `thread_owner_child`, `goat-thread_owner_*` also matches tools under `goat-thread_owner_child`. This overlap already exists under `t3-code`; a prefix rename did not create it. Hashing lossy ids fixes the cycle-3 registration collision but does not establish universal wildcard isolation for lossless readable ids (nor remove every digest/readable namespace edge case). Keep this as a follow-up owned by the parent; do not change wildcard rules, namespace encoding or permission semantics in this unit. Register/remove symmetry and this residual must remain explicit in independent review; do not claim that fixing the collision resolves this separate permission issue.

## 3. File map

Each exact path below is relative to the source root and marked MODIFY. The matching complete diff is in §5. Fixture files are individually enumerated and receive complete real-line hunks.

| Operation | Exact path                                                                                                    | Responsibility                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MODIFY    | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`                                                 | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-cursor/src/server/adapter.ts`                                                              | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-cursor/src/server/adapter.test.ts`                                                         | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-muse/src/server/adapter.ts`                                                                | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-muse/src/server/adapter.test.ts`                                                           | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-opencode/src/server/adapter.ts`                                                            | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-acp/src/server/mcpOverAcpBridge.ts`                                                        | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `apps/server/src/provider/CodexDeveloperInstructions.ts`                                                      | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `apps/server/src/provider/CodexDeveloperInstructions.test.ts`                                                 | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-core/src/server/runtimeInstructions.ts`                                                    | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-core/src/server/runtimeInstructions.test.ts`                                               | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-core/src/server/orchestrationInstructions.ts`                                              | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `apps/server/src/cli/acpMcpBridge.ts`                                                                         | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `apps/server/src/mcp/McpSessionRegistry.ts`                                                                   | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/contracts/src/settings.ts`                                                                          | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/contracts/src/previewAutomation.ts`                                                                 | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts`                                                   | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/effect-acp/test/fixtures/acp-mock-peer.ts`                                                          | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `apps/server/src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts`                                | Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.                                                                                                                                                                                        |
| MODIFY    | `packages/provider-acp/src/server/adapter.ts`                                                                 | One shared ACP injection path serves generic ACP, Grok and Antigravity. Keep ACP clientInfo unchanged.                                                                                                                                                                                                             |
| MODIFY    | `packages/provider-acp/src/server/runtimeModel.ts`                                                            | Update prefix/suffix regexes and all three asserted-origin checks together. Explicit foreign metadata still wins; known-tool inventory still gates loose titles.                                                                                                                                                   |
| MODIFY    | `packages/provider-acp/src/server/runtimeModel.test.ts`                                                       | Replay real ACP title/meta shapes under goat and test foreign-origin precedence and case/whitespace handling. goat_thread_send consumes wp3.                                                                                                                                                                       |
| MODIFY    | `packages/provider-acp/src/server/mcpOverAcpBridge.test.ts`                                                   | The bridge accepts goat only; reject both an unknown origin and the retired registration key before allocating a connection.                                                                                                                                                                                       |
| MODIFY    | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`                                                | Final allowlist is mcp__goat__goat_* for wp3-renamed tools and mcp__goat__<unchanged-tool> otherwise; read-only mode never gains wildcard.                                                                                                                                                                         |
| MODIFY    | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`                                           | Update query/mcpServers/wildcard and toolkit-annotation cross-check to the goat namespace. Existing tests cover credential rotation and read-only policy.                                                                                                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`                                            | Test Codex wire registration, qualified projected names and resumed tool calls; temporary directory names remain unchanged.                                                                                                                                                                                        |
| MODIFY    | `apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts`                                              | Assert goat in injected stdio server and projected tool identity for the shared ACP adapter.                                                                                                                                                                                                                       |
| MODIFY    | `packages/provider-opencode/src/server/v2/adapter.ts`                                                         | Keep directory registration and same-name cleanup; digest raw ids whenever sanitization is lossy or the name is over 64 characters. Deny legacy names before allowing the current goat thread; record the pre-existing wildcard-overlap residual separately.                                                       |
| MODIFY    | `apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts`                                        | Replay registration and symmetric removal, dual namespace deny rules and own-thread allow, resume/fork policy, exact 64-character lossless boundary and distinct digests for the 59-character lossy collision pair. Keep lossy-id permission expectations consistent; wildcard overlap is a pre-existing residual. |
| MODIFY    | `apps/server/src/orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts`                                | Replay registration and symmetric removal, dual namespace deny rules and own-thread allow, resume/fork policy, exact 64-character lossless boundary and distinct digests for the 59-character lossy collision pair. Keep lossy-id permission expectations consistent; wildcard overlap is a pre-existing residual. |
| MODIFY    | `packages/provider-pi/src/server/mcpExtensionSource.ts`                                                       | Exactly one callable registration per catalog item. Preserve pre-builtin ownership, direct/deferred discovery, cancellation, retry and permissions; no hidden duplicate.                                                                                                                                           |
| MODIFY    | `packages/provider-pi/src/server/mcpExtensionSource.test.ts`                                                  | Execute generated Pi extension, count registration attempts before the mock deduplicates, verify discovery and raw HTTP tool name, and retain selected/excluded tool/approval behavior.                                                                                                                            |
| MODIFY    | `packages/provider-pi/src/server/mcpInjection.test.ts`                                                        | Remove source-string assertions that would mirror prefix implementation; the generated-extension execution test above proves the behavior.                                                                                                                                                                         |
| MODIFY    | `packages/shared/src/t3McpToolPresentation.ts`                                                                | Required reader-side companion to D6: add goat without deleting old namespace aliases or changing logo/icon identities. wp3 owns bare goat_* inventory aliases.                                                                                                                                                    |
| MODIFY    | `packages/shared/src/t3McpToolPresentation.test.ts`                                                           | Retain all old-history assertions and add every new namespace spelling plus per-thread and foreign/unknown rendering behavior.                                                                                                                                                                                     |
| MODIFY    | `packages/shared/src/htmlRender.test.ts`                                                                      | Verify rendered HTML attachments still resolve from goat qualified names and retained legacy names.                                                                                                                                                                                                                |
| MODIFY    | `packages/provider-core/src/server/mcpToolPresentation.test.ts`                                               | GOAT tools use product-owned presentation instead of acquiring a generic integration card; legacy history still behaves the same.                                                                                                                                                                                  |
| MODIFY    | `docs/orchestration-v2/orchestrator-mcp-server.md`                                                            | Correct the server key, Codex overrides and Claude wildcard, and replace obsolete Pi hidden-alias guidance with the single-registration/loadout contract.                                                                                                                                                          |
| MODIFY    | `docs/internals/providers.md`                                                                                 | Update the existing cross-thread isolation constraint, including the residual old-daemon risk.                                                                                                                                                                                                                     |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/grok_auto_blocked_command/grok_transcript.ndjson`          | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash/grok_transcript.ndjson`               | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash_fast_wake/grok_transcript.ndjson`     | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/grok_background_subagent/grok_transcript.ndjson`           | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/grok_monitor/grok_transcript.ndjson`                       | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/grok_prompt_error/grok_transcript.ndjson`                  | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/grok_transcript.ndjson`                   | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/pi_transcript.ndjson`                     | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/grok_transcript.ndjson`                         | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/muse_transcript.ndjson`                         | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/pi_transcript.ndjson`                           | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/muse_permission/muse_transcript.ndjson`                    | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/muse_workflow/muse_transcript.ndjson`                      | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_background/opencode_transcript.ndjson`           | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_command/opencode_transcript.ndjson`              | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_compaction/opencode_transcript.ndjson`           | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_fork/opencode_transcript.ndjson`                 | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_inbox/opencode_transcript.ndjson`                | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_interrupt/opencode_transcript.ndjson`            | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_nested_background/opencode_transcript.ndjson`    | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_permission/opencode_transcript.ndjson`           | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_question/opencode_transcript.ndjson`             | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_resume_after_restart/opencode_transcript.ndjson` | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_revert/opencode_transcript.ndjson`               | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_simple/opencode_transcript.ndjson`               | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_skill/opencode_transcript.ndjson`                | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_subagent/opencode_transcript.ndjson`             | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_switch/opencode_transcript.ndjson`               | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_tool_call/opencode_transcript.ndjson`            | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/pi_compaction/pi_transcript.ndjson`                        | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_transcript.ndjson`               | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/grok_transcript.ndjson`                        | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson`                             | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/simple/muse_transcript.ndjson`                             | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_transcript.ndjson`                               | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback/pi_transcript.ndjson`                      | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson`           | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/todo_list/grok_transcript.ndjson`                          | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/grok_transcript.ndjson`     | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/grok_transcript.ndjson`                     | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/muse_transcript.ndjson`                     | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/pi_transcript.ndjson`              | Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.                                                                          |
| MODIFY    | `apps/server/src/mcp/McpHttpServer.ts`                                                                        | Amend only the existing provider reconnect comment; wp3 owns McpServer name and toolkit changes.                                                                                                                                                                                                                   |

| MODIFY | `packages/provider-opencode/src/server/adapter.test.ts` | Exercise the actual OpenCode 1 openSession boundary: inject goat with scoped HTTP credential only for a managed server, and inject nothing for external servers or absent credentials. |

## 4. Observable tests and conditional activation

| Scenario / activation                                                                               | Required observable result                                                                                                                                           | Owning tests                                                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Codex startup/resume/fork with a scoped MCP session                                                 | config contains only goat; same endpoint/header; projected GOAT calls remain product tools                                                                           | CodexAdapterV2.test.ts                                                  |
| Cursor/Muse scoped session                                                                          | SDK options contain goat with existing authorization; absence path does not inject tools                                                                             | provider-cursor / provider-muse adapter.test.ts                         |
| Generic ACP, Grok, Antigravity through shared ACP adapter                                           | stdio name and advertised MCP-over-ACP serverId both goat; transport selection/fallback unchanged                                                                    | AcpAdapterV2.test.ts; AcpJsonRpcConnection.test.ts                      |
| MCP-over-ACP connect goat / old key / foreign key                                                   | goat can message/disconnect; old/foreign rejected with typed bridge error before HTTP                                                                                | mcpOverAcpBridge.test.ts                                                |
| ACP wire titles (prefix, suffix, separators, bare), rewritten/titleless updates, qwen/goose origins | known tools recover goat; explicit foreign origin wins; unknown/path-like names remain generic; fallback JSON input retained                                         | runtimeModel.test.ts                                                    |
| OpenCode 1 managed/external server, credential present/absent                                       | actual openSession emits goat mcp.add with scoped credential only on owned server                                                                                    | provider-opencode/src/server/adapter.test.ts                            |
| OpenCode 2 resumed/forked full-access/approval/plan session                                         | outbound permissions deny both namespaces then allow only own goat server; registration/removal uses same name and credential                                        | OpenCode2AdapterV2.test.ts; OpenCode2OrchestratorV2.integration.test.ts |
| OpenCode lossless id length 59 / 60, lossy ids that fit and distinct long ids                       | Lossless 59-character id stays readable at 64 characters; 60-character or lossy id uses deterministic 21-character raw-id digest; long ids stay distinct             | OpenCode2AdapterV2.test.ts                                              |
| OpenCode exact pair `thread:` + 49 `x` + `a:b` / `a_b` (both 59 characters)                         | Same-directory HTTP replay registers distinct `goat-a8a5047e3b3ef95f` / `goat-84c3953c7ac1e4ef` with own credentials; unload removes each same name                  | OpenCode2AdapterV2.test.ts (existing HTTP replay harness)               |
| Pi modern builtin search, absent/disabled/excluded builtin search, tree loadout                     | one register attempt per item initially, no hidden shadow, correct direct/deferred exposure, excluded calls remain excluded                                          | mcpExtensionSource.test.ts                                              |
| Pi execute and approval-required tool call                                                          | original catalog name sent over HTTP, abort signal forwarded, details.server goat, discovery remains read-only while tool still prompts                              | mcpExtensionSource.test.ts                                              |
| Claude full-access vs read-only session, explicit/no allowlist, credential rotation                 | wildcard only in non-read-only policy; read-only list exactly matches toolkit annotations under final namespace; credential stays out of process args/log projection | ClaudeAdapterV2.test.ts                                                 |
| Fresh goat qualified names and persisted t3-code aliases                                            | same product presentation/HTML reference; foreign or unknown tools remain generic                                                                                    | shared presentation/htmlRender tests; provider-core presentation test   |
| Edited Pi/Grok/Muse/OpenCode replay transcripts                                                     | deterministic replay consumes new warning/instruction/key/rule strings without changed scenario outcomes                                                             | focused replay integration/contract tests                               |

The added/updated assertions exercise generated Pi execution, actual adapter wire options, metadata recovery, public result presentation, permissions and name-limit behavior. No new static-render, callback-wiring or source-string prefix tests are added. Existing Pi materialization prefix string assertions are removed in favor of the execution test. No sleeps/polling are added; replay/effect tests retain their existing drain/terminal barriers.

## 5. Exact before/after hunks

Each `diff` block is a complete unified patch for its stated file, generated from literal inspected source lines. Context is intentionally small for fixtures (their records are real full NDJSON lines). No `...` placeholders truncate a hunk. Copy the blocks into a patch outside the worktree; parent may validate/apply them against the checked `f08a410af` bytes. Refresh earlier-phase overlaps if source moves again. The prose does not authorize this leaf to apply anything.

The stale check has refreshed before-images for the integrated wp3 source at `f08a410af`. This extracts every diff block into the parent's temporary directory and checks it without applying. Run only in the source worktree. On any preimage failure, amend this document first; do not force application. The final `git apply` is parent-owned source editing, not a branch/commit operation; this leaf never invokes it.

````sh
python3 - <<'PY_PATCH'
from pathlib import Path
import re, subprocess, tempfile
plan = Path('/Users/jun/Developer/new/700_projects/goat/devlog/_fin/261011_goat-release-rename/050_provider_key_goat.md')
blocks = re.findall(r'^```diff\n(.*?)^```$', plan.read_text(), flags=re.M | re.S)
assert blocks, 'no executable diff blocks'
patch = ''.join(blocks)
with tempfile.NamedTemporaryFile(mode='w', suffix='.patch', prefix='goat-wp6-', delete=False) as file:
    file.write(patch)
    patch_path = file.name
subprocess.run(['git', 'apply', '--check', patch_path], check=True)
print(patch_path)
PY_PATCH
# Then apply only the checked path printed above, after parent scope review:
# git apply /absolute/printed/goat-wp6-....patch
````

### MODIFY `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
+++ b/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
@@ -1316,7 +1316,7 @@
         ? {}
         : {
             mcp_servers: {
-              "t3-code": {
+              "goat": {
                 url: mcpSession.endpoint,
                 http_headers: {
                   Authorization: mcpSession.authorizationHeader,
```

### MODIFY `packages/provider-cursor/src/server/adapter.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-cursor/src/server/adapter.ts
+++ b/packages/provider-cursor/src/server/adapter.ts
@@ -208,7 +208,7 @@
     return undefined;
   }
   return {
-    "t3-code": {
+    "goat": {
       type: "http",
       url: session.endpoint,
       headers: {
```

### MODIFY `packages/provider-cursor/src/server/adapter.test.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-cursor/src/server/adapter.test.ts
+++ b/packages/provider-cursor/src/server/adapter.test.ts
@@ -883,7 +883,7 @@
     };

     assert.deepEqual(cursorMcpServers(mcpSession), {
-      "t3-code": {
+      "goat": {
         type: "http",
         url: "http://127.0.0.1:43123/mcp",
         headers: {
```

### MODIFY `packages/provider-muse/src/server/adapter.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-muse/src/server/adapter.ts
+++ b/packages/provider-muse/src/server/adapter.ts
@@ -1501,7 +1501,7 @@
                 mcpServers: {
                   // Muse defaults to "required", which fails the whole run when T3's
                   // tools cannot be reached. The agent should still work without them.
-                  "t3-code": {
+                  "goat": {
                     transport: "streamableHttp",
                     mode: "optional",
                     url: mcpSession.endpoint,
```

### MODIFY `packages/provider-muse/src/server/adapter.test.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-muse/src/server/adapter.test.ts
+++ b/packages/provider-muse/src/server/adapter.test.ts
@@ -368,7 +368,7 @@
         const call = yield* fake.takeCall(nativeId ? "session/resume" : "session/start");
         assert.deepStrictEqual(call.params.config, {
           mcpServers: {
-            "t3-code": {
+            "goat": {
               transport: "streamableHttp",
               mode: "optional",
               url: "http://127.0.0.1:43210/mcp",
```

### MODIFY `packages/provider-opencode/src/server/adapter.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-opencode/src/server/adapter.ts
+++ b/packages/provider-opencode/src/server/adapter.ts
@@ -975,7 +975,7 @@
         if (hasT3Mcp) {
           yield* OpenCodeRuntime.runOpenCodeSdk("mcp.add", () =>
             client.mcp.add({
-              name: "t3-code",
+              name: "goat",
               config: {
                 type: "remote",
                 url: mcpSession.endpoint,
```

### MODIFY `packages/provider-acp/src/server/mcpOverAcpBridge.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-acp/src/server/mcpOverAcpBridge.ts
+++ b/packages/provider-acp/src/server/mcpOverAcpBridge.ts
@@ -181,7 +181,7 @@
   return {
     connect: (request) =>
       Effect.gen(function* () {
-        if (request.serverId !== "t3-code") {
+        if (request.serverId !== "goat") {
           return yield* Effect.fail(
             new AcpMcpOverAcpError(`Unknown ACP MCP server "${request.serverId}".`),
           );
```

### MODIFY `apps/server/src/provider/CodexDeveloperInstructions.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/apps/server/src/provider/CodexDeveloperInstructions.ts
+++ b/apps/server/src/provider/CodexDeveloperInstructions.ts
@@ -9,7 +9,7 @@

 const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## T3 Code devices

-The \`t3-code\` MCP server also exposes \`device_*\` tools for iOS Simulators and Android Emulators on this environment. For mobile verification, call \`device_list\`, then \`device_open\` so the user can watch the device in their Device panel; its result explains how to drive the device. Driving happens through the \`agent-device\` CLI, using the exact launcher path returned by \`device_open\`. Keep the host config and session flags returned by \`device_open\` on every command so concurrent devices stay independent: prefer \`agent-device snapshot -i\` refs over coordinates, and use \`device_screenshot\` when you need to see the screen. Prefer these tools and \`agent-device\` for opening and driving devices. Platform tools such as \`xcrun simctl\` and \`adb\` remain available for anything they do not cover, such as builds, logs, or port forwarding. If \`device_list\` reports a platform as unavailable, say so.`;
+The \`goat\` MCP server also exposes \`device_*\` tools for iOS Simulators and Android Emulators on this environment. For mobile verification, call \`device_list\`, then \`device_open\` so the user can watch the device in their Device panel; its result explains how to drive the device. Driving happens through the \`agent-device\` CLI, using the exact launcher path returned by \`device_open\`. Keep the host config and session flags returned by \`device_open\` on every command so concurrent devices stay independent: prefer \`agent-device snapshot -i\` refs over coordinates, and use \`device_screenshot\` when you need to see the screen. Prefer these tools and \`agent-device\` for opening and driving devices. Platform tools such as \`xcrun simctl\` and \`adb\` remain available for anything they do not cover, such as builds, logs, or port forwarding. If \`device_list\` reports a platform as unavailable, say so.`;

 export interface T3CodeToolAvailability {
   readonly browser: boolean;
@@ -206,7 +206,7 @@
 export function buildCodexAdditionalContext(
   runtime: CodexRuntimeInfo,
   /**
-   * Whether the `t3-code` MCP server is attached to this turn. Callers derive
+   * Whether the `goat` MCP server is attached to this turn. Callers derive
    * it from the session's actual MCP configuration rather than re-reading the
    * setting, so the prompt cannot claim tools the turn doesn't have.
    */
```

### MODIFY `apps/server/src/provider/CodexDeveloperInstructions.test.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/apps/server/src/provider/CodexDeveloperInstructions.test.ts
+++ b/apps/server/src/provider/CodexDeveloperInstructions.test.ts
@@ -76,7 +76,7 @@
   it("prefers the product-native preview tools in both collaboration modes", () => {
     {
       const instructions = toolInstructions(runtime, true);
-      NodeAssert.match(instructions, /t3-code/);
+      NodeAssert.match(instructions, /goat/);
       NodeAssert.match(instructions, /preview_status/);
       NodeAssert.match(instructions, /preview_open/);
       NodeAssert.match(instructions, /Do not switch to global browser skills/);
```

### MODIFY `packages/provider-core/src/server/runtimeInstructions.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-core/src/server/runtimeInstructions.ts
+++ b/packages/provider-core/src/server/runtimeInstructions.ts
@@ -1,5 +1,5 @@
 const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
-When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
+When the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
 </pull_request_linking>`;

 /**
```

### MODIFY `packages/provider-core/src/server/runtimeInstructions.test.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-core/src/server/runtimeInstructions.test.ts
+++ b/packages/provider-core/src/server/runtimeInstructions.test.ts
@@ -4,7 +4,7 @@
 describe("buildRuntimeInstructions", () => {
   it("requires explicit registration of every PR and stack layer", () => {
     const instructions = buildRuntimeInstructions({ harness: "Codex" });
-    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
+    expect(instructions).toContain("When the goat MCP server exposes link_pull_request");
     expect(instructions).toContain("with the full PR URL immediately after creating a PR");
     expect(instructions).toContain("For a stack, call it for every layer");
     expect(instructions).toContain("call list_thread_pull_requests and link any PR");
```

### MODIFY `packages/provider-core/src/server/orchestrationInstructions.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/provider-core/src/server/orchestrationInstructions.ts
+++ b/packages/provider-core/src/server/orchestrationInstructions.ts
@@ -4,7 +4,7 @@

 ## T3 Code orchestration

-The \`t3-code\` MCP server provides app-owned orchestration. Treat these concepts distinctly:
+The \`goat\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

 - A delegated task/subagent is child work owned by the current thread. Use \`orchestrator_capabilities\` to discover the current provider/model IDs from the same live catalog as the composer, including configured custom models. Do not treat a native tool's model list as the full list of available subagent models. Prefer native subagent tools for same-provider work only when they support the chosen model. Use \`delegate_task\` with that provider instance and model when native tools cannot, including for same-provider work. Also use \`delegate_task\` for cross-provider or explicitly T3-owned child tasks. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent, not the target for starting another delegated review round.
 - \`goat_thread_launch\` and \`create_threads\` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
@@ -29,7 +29,7 @@

 To work on ANOTHER machine, use the SSH tools instead of running ssh in a terminal: \`goat_ssh_host_list\` names the hosts this machine can reach, \`goat_ssh_browse\` lists a folder there with its Git branch and worktrees, and \`goat_ssh_thread_launch\` starts a thread in that machine's own T3 environment, in the folder (\`workspace:{"type":"cwd"}\`) or a new worktree (\`{"type":"worktree","branch":"feature/x"}\`). Its threadId belongs to that machine, so \`goat_thread_read\` here cannot read it; tell the user to connect that host in Settings to follow it.

-Tool names may include a harness-normalized MCP prefix, such as \`mcp__t3_code__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.
+Tool names may include a harness-normalized MCP prefix, such as \`mcp__goat__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__goat__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.

 ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset when T3 runs as a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.

@@ -42,7 +42,7 @@

 ## T3 Code collaborative browser

-You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.
+You are running inside T3 Code. The \`goat\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

 For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

```

### MODIFY `apps/server/src/cli/acpMcpBridge.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/apps/server/src/cli/acpMcpBridge.ts
+++ b/apps/server/src/cli/acpMcpBridge.ts
@@ -8,7 +8,7 @@
  *
  * The T3 server injects this command (with per-session endpoint and
  * credential environment variables) into `session/new` so every ACP agent
- * reaches the t3-code toolkit through ACP's required stdio MCP transport.
+ * reaches the goat toolkit through ACP's required stdio MCP transport.
  * The credential stays in the environment, never on the command line.
  *
  * Real invocations dispatch through the bin.ts fast path before the CLI
```

### MODIFY `apps/server/src/mcp/McpSessionRegistry.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/apps/server/src/mcp/McpSessionRegistry.ts
+++ b/apps/server/src/mcp/McpSessionRegistry.ts
@@ -77,7 +77,7 @@
  *
  * The bound matters because `/mcp` is mounted outside the environment auth
  * stack and is reachable on whatever host the server binds to, so this token is
- * the only thing guarding the `t3-code` toolkits on a remote-reachable server.
+ * the only thing guarding the `goat` toolkits on a remote-reachable server.
  */
 const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

```

### MODIFY `packages/contracts/src/settings.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/contracts/src/settings.ts
+++ b/packages/contracts/src/settings.ts
@@ -1109,7 +1109,7 @@
   ),
   /**
    * Whether agents may drive the in-app preview browser. Turning this off
-   * withholds the MCP credential, so the `t3-code` server (and with it every
+   * withholds the MCP credential, so the `goat` server (and with it every
    * `preview_*` tool) is never attached to a provider session, and the prompt
    * text describing those tools is dropped along with them. The user's own
    * browser panel is unaffected — this gates agent access only.
```

### MODIFY `packages/contracts/src/previewAutomation.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/contracts/src/previewAutomation.ts
+++ b/packages/contracts/src/previewAutomation.ts
@@ -861,7 +861,7 @@
   }
 }

-/** A `t3-code` MCP tool was called with a credential that does not carry its capability. */
+/** A `goat` MCP tool was called with a credential that does not carry its capability. */
 export class McpCapabilityUnavailableError extends Schema.TaggedError<McpCapabilityUnavailableError>()(
   "McpCapabilityUnavailableError",
   {
```

### MODIFY `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts
+++ b/apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts
@@ -588,7 +588,7 @@
         (event) => event.method === "session/new" && event.status === "started",
       );
       expect(created?.payload).toMatchObject({
-        mcpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
+        mcpServers: [{ type: "acp", name: "goat", serverId: "goat" }],
       });
     }).pipe(
       Effect.provide(
@@ -601,8 +601,8 @@
           cwd: process.cwd(),
           clientInfo: { name: "t3-test", version: "0.0.0" },
           authMethodId: "test",
-          mcpServers: [{ type: "stdio", name: "t3-code", command: "/usr/bin/node", args: [] }],
-          acpMcpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
+          mcpServers: [{ type: "stdio", name: "goat", command: "/usr/bin/node", args: [] }],
+          acpMcpServers: [{ type: "acp", name: "goat", serverId: "goat" }],
           requestLogger: (event) =>
             Effect.sync(() => {
               requestEvents.push(event);
@@ -624,20 +624,20 @@
         (event) => event.method === "session/new" && event.status === "started",
       );
       expect(created?.payload).toMatchObject({
-        mcpServers: [{ type: "stdio", name: "t3-code", command: "/usr/bin/node", args: [] }],
-      });
-    }).pipe(
-      Effect.provide(
-        AcpSessionRuntime.layer({
-          spawn: {
-            command: mockAgentCommand,
-            args: mockAgentArgs,
-          },
-          cwd: process.cwd(),
-          clientInfo: { name: "t3-test", version: "0.0.0" },
-          authMethodId: "test",
-          mcpServers: [{ type: "stdio", name: "t3-code", command: "/usr/bin/node", args: [] }],
-          acpMcpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
+        mcpServers: [{ type: "stdio", name: "goat", command: "/usr/bin/node", args: [] }],
+      });
+    }).pipe(
+      Effect.provide(
+        AcpSessionRuntime.layer({
+          spawn: {
+            command: mockAgentCommand,
+            args: mockAgentArgs,
+          },
+          cwd: process.cwd(),
+          clientInfo: { name: "t3-test", version: "0.0.0" },
+          authMethodId: "test",
+          mcpServers: [{ type: "stdio", name: "goat", command: "/usr/bin/node", args: [] }],
+          acpMcpServers: [{ type: "acp", name: "goat", serverId: "goat" }],
           requestLogger: (event) =>
             Effect.sync(() => {
               requestEvents.push(event);
```

### MODIFY `packages/effect-acp/test/fixtures/acp-mock-peer.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/packages/effect-acp/test/fixtures/acp-mock-peer.ts
+++ b/packages/effect-acp/test/fixtures/acp-mock-peer.ts
@@ -97,7 +97,7 @@
   yield* agent.handlePrompt(() =>
     Effect.gen(function* () {
       if (mcpOverAcp) {
-        const connected = yield* agent.client.connectMcp({ serverId: "t3-code" });
+        const connected = yield* agent.client.connectMcp({ serverId: "goat" });
         yield* agent.client.messageMcp({
           connectionId: connected.connectionId,
           method: "tools/list",
```

### MODIFY `apps/server/src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts`

Use the GOAT registration identity in the existing provider/transport contract; keep APIs and credential environment names.

```diff
--- a/apps/server/src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts
+++ b/apps/server/src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts
@@ -73,7 +73,7 @@
       ...statusIds.map((id) => ({
         type: "tool_use",
         id,
-        name: "mcp__t3-code__task_status",
+        name: "mcp__goat__task_status",
         input: { taskId: id },
       })),
     ],
```

### MODIFY `packages/provider-acp/src/server/adapter.ts`

One shared ACP injection path serves generic ACP, Grok and Antigravity. Keep ACP clientInfo unchanged.

```diff
--- a/packages/provider-acp/src/server/adapter.ts
+++ b/packages/provider-acp/src/server/adapter.ts
@@ -659,7 +659,7 @@
     },
     tools: {
       ...base.tools,
-      // The stdio bridge (`t3 acp-mcp-bridge`) makes the t3-code MCP toolkit
+      // The stdio bridge (`t3 acp-mcp-bridge`) makes the goat MCP toolkit
       // available regardless of the agent's optional http/sse MCP support.
       supportsMcpTools: true,
     },
@@ -694,7 +694,7 @@
   return {
     servers: [
       {
-        name: "t3-code",
+        name: "goat",
         command: self.command,
         args: [...selfInvocationArgs(self, ["acp-mcp-bridge"])],
         env: [
@@ -704,7 +704,7 @@
         ],
       },
     ],
-    acpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
+    acpServers: [{ type: "acp", name: "goat", serverId: "goat" }],
     endpoint: session.endpoint,
     authorization: session.authorizationHeader,
     processEnvironment: {
```

### MODIFY `packages/provider-acp/src/server/runtimeModel.ts`

Update prefix/suffix regexes and all three asserted-origin checks together. Explicit foreign metadata still wins; known-tool inventory still gates loose titles.

```diff
--- a/packages/provider-acp/src/server/runtimeModel.ts
+++ b/packages/provider-acp/src/server/runtimeModel.ts
@@ -1078,22 +1078,22 @@
 /**
  * Agents flatten injected MCP tools into model-facing function names with no
  * shared convention (survey of the 2026-08 registry builds): Kilo and
- * opencode use `t3-code_<tool>`, claude-acp and qwen `mcp__t3-code__<tool>`,
- * Amp `mcp__t3_code__<tool>` (hyphens mangled), droid `t3-code___<tool>`,
- * Copilot `t3-code-<tool>`, cline appends `: <args json>`. T3 always injects
- * its server as "t3-code", and matches are additionally gated on the known
+ * opencode use `goat_<tool>`, claude-acp and qwen `mcp__goat__<tool>`,
+ * Amp `mcp__goat__<tool>` (normalization is identical), droid `goat___<tool>`,
+ * Copilot `goat-<tool>`, cline appends `: <args json>`. T3 always injects
+ * its server as "goat", and matches are additionally gated on the known
  * T3 tool inventory, so the separator match can stay loose.
  */
 const T3_MCP_TITLE_CALL =
-  /^(?:mcp[-_]{1,2})?t3[-_ ]?code[-_.:/ ]{1,3}(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*)(?::.*)?$/i;
+  /^(?:mcp[-_]{1,2})?goat[-_.:/ ]{1,3}(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*)(?::.*)?$/i;

 /**
  * Gemini CLI titles injected MCP calls "<tool> (<server> MCP Server)" and
  * qwen-code appends ": <args json>" to the same template; Auggie namespaces
- * tool-first as "<tool>_t3-code".
+ * tool-first as "<tool>_goat".
  */
 const T3_MCP_TITLE_SUFFIX_CALL =
-  /^(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*?)(?: \(t3[-_ ]?code MCP Server\)(?::|$)|[-_.]t3[-_ ]?code$)/i;
+  /^(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*?)(?: \(goat MCP Server\)(?::|$)|[-_.]goat$)/i;

 /**
  * glm-acp-agent and Kimi CLI register injected MCP tools under their bare
@@ -1141,7 +1141,7 @@
   // its toolName identifies the call even under future prefix formats.
   const metaServerId = typeof meta?.serverId === "string" ? meta.serverId.trim() : "";
   const metaToolName = typeof meta?.toolName === "string" ? meta.toolName.trim() : "";
-  if (/^t3[-_ ]?code$/i.test(metaServerId) && metaToolName.length > 0) {
+  if (/^goat$/i.test(metaServerId) && metaToolName.length > 0) {
     for (const knownTool of T3_MCP_TOOL_NAMES) {
       const boundary = metaToolName.length - knownTool.length - 1;
       if (
@@ -1150,15 +1150,15 @@
           boundary >= 0 &&
           !/[A-Za-z0-9]/.test(metaToolName.charAt(boundary)))
       ) {
-        return { server: "t3-code", tool: knownTool };
+        return { server: "goat", tool: knownTool };
       }
     }
   }
   const gooseExtension =
     typeof gooseToolCall?.extensionName === "string" ? gooseToolCall.extensionName.trim() : "";
   const assertsForeignOrigin =
-    (metaServerId.length > 0 && !/^t3[-_ ]?code$/i.test(metaServerId)) ||
-    (gooseExtension.length > 0 && !/^t3[-_ ]?code$/i.test(gooseExtension));
+    (metaServerId.length > 0 && !/^goat$/i.test(metaServerId)) ||
+    (gooseExtension.length > 0 && !/^goat$/i.test(gooseExtension));
   // A foreign origin never brands as T3. qwen's serverId marks a real MCP
   // server, but goose reports its built-in extensions (developer__shell,
   // edits) the same way as user MCP servers, so goose stays unclassified and
@@ -1180,7 +1180,7 @@
   for (const candidate of candidates) {
     const trimmed = candidate.trim();
     const qualified = /^mcp__(.+?)__(.+)$/i.exec(trimmed);
-    if (qualified?.[1] && qualified[2] && !/^t3[-_ ]?code$/i.test(qualified[1]))
+    if (qualified?.[1] && qualified[2] && !/^goat$/i.test(qualified[1]))
       return { server: qualified[1], tool: qualified[2] };
     const match =
       T3_MCP_TITLE_CALL.exec(trimmed) ??
@@ -1188,7 +1188,7 @@
       T3_MCP_BARE_TITLE_CALL.exec(trimmed);
     const candidateTool = match?.groups?.tool;
     if (candidateTool !== undefined && T3_MCP_TOOL_NAMES.has(candidateTool)) {
-      return { server: "t3-code", tool: candidateTool };
+      return { server: "goat", tool: candidateTool };
     }
   }
   const commands = [
@@ -1203,7 +1203,7 @@
       // The acp-mcp-call CLI exists only as T3's bridge fallback, so the
       // server identity is T3's by construction.
       const input = acpMcpFallbackInput(match[2]);
-      return { server: "t3-code", tool: match[1], ...(input === undefined ? {} : { input }) };
+      return { server: "goat", tool: match[1], ...(input === undefined ? {} : { input }) };
     }
   }
   return undefined;
```

### MODIFY `packages/provider-acp/src/server/runtimeModel.test.ts`

Replay real ACP title/meta shapes under goat and test foreign-origin precedence and case/whitespace handling. goat_thread_send consumes wp3.

```diff
--- a/packages/provider-acp/src/server/runtimeModel.test.ts
+++ b/packages/provider-acp/src/server/runtimeModel.test.ts
@@ -1413,14 +1413,14 @@
       sessionUpdate: "tool_call",
       toolCallId: "exec-f4591587-0754-4bb4-990b-f2767894ba93",
       kind: "execute",
-      title: "mcp.t3-code.orchestrator_capabilities",
+      title: "mcp.goat.orchestrator_capabilities",
       status: "in_progress",
-      rawInput: { server: "t3-code", tool: "orchestrator_capabilities", arguments: {} },
+      rawInput: { server: "goat", tool: "orchestrator_capabilities", arguments: {} },
       _meta: { is_mcp_tool_call: true },
     });

     expect(extractMcpToolCallIdentity(toolCall)).toEqual({
-      server: "t3-code",
+      server: "goat",
       tool: "orchestrator_capabilities",
     });
   });
@@ -1440,7 +1440,7 @@
           '/usr/bin/node /srv/t3/bin.ts acp-mcp-call delegate_task {"task":"x"}',
         ],
       }),
-    ).toEqual({ server: "t3-code", tool: "delegate_task", input: { task: "x" } });
+    ).toEqual({ server: "goat", tool: "delegate_task", input: { task: "x" } });
   });

   it("recovers T3 identity from pi-acp title-only fallback execs", () => {
@@ -1465,7 +1465,7 @@

     expect(toolCall.title).toBe("Ran command");
     expect(extractMcpToolCallIdentity(toolCall)).toEqual({
-      server: "t3-code",
+      server: "goat",
       tool: "orchestrator_capabilities",
       input: {},
     });
@@ -1480,7 +1480,7 @@
       sessionUpdate: "tool_call",
       toolCallId: "chatcmpl-tool-b2a6142ee1a510a5",
       kind: "other",
-      title: "t3-code_orchestrator_capabilities",
+      title: "goat_orchestrator_capabilities",
       status: "pending",
       locations: [],
       rawInput: {},
@@ -1494,7 +1494,7 @@
     const merged = mergeToolCallState(created, completed);

     expect(extractMcpToolCallIdentity(merged)).toEqual({
-      server: "t3-code",
+      server: "goat",
       tool: "orchestrator_capabilities",
     });
   });
@@ -1506,23 +1506,23 @@
       sessionUpdate: "tool_call",
       toolCallId: "gemini-1",
       kind: "other",
-      title: "delegate_task (t3-code MCP Server)",
+      title: "delegate_task (goat MCP Server)",
       status: "in_progress",
     });
     const qwen = toolCallFromUpdate({
       sessionUpdate: "tool_call",
       toolCallId: "qwen-1",
       kind: "other",
-      title: 'task_status (t3-code MCP Server): {"taskId":"node:delegated-task:1"}',
+      title: 'task_status (goat MCP Server): {"taskId":"node:delegated-task:1"}',
       status: "pending",
       rawInput: { taskId: "node:delegated-task:1" },
     });

     expect(extractMcpToolCallIdentity(gemini)).toEqual({
-      server: "t3-code",
+      server: "goat",
       tool: "delegate_task",
     });
-    expect(extractMcpToolCallIdentity(qwen)).toEqual({ server: "t3-code", tool: "task_status" });
+    expect(extractMcpToolCallIdentity(qwen)).toEqual({ server: "goat", tool: "task_status" });
   });

   it("recovers T3 identity across the registry agents' naming conventions", () => {
@@ -1534,12 +1534,12 @@
     // tail, cline args tail, Auggie tool-first suffix, fast-agent slash,
     // Kimi bare name with args tail.
     for (const title of [
-      "t3-code___delegate_task",
-      "t3-code-delegate_task",
-      'mcp__t3_code__delegate_task: {"mode":"async"}',
-      't3-code__delegate_task: {"mode":"async"}',
-      "delegate_task_t3-code",
-      "t3-code/delegate_task",
+      "goat___delegate_task",
+      "goat-delegate_task",
+      'mcp__goat__delegate_task: {"mode":"async"}',
+      'goat__delegate_task: {"mode":"async"}',
+      "delegate_task_goat",
+      "goat/delegate_task",
       'delegate_task: {"mode":"async"}',
     ]) {
       const toolCall = toolCallFromUpdate({
@@ -1550,7 +1550,7 @@
         status: "pending",
       });
       expect(extractMcpToolCallIdentity(toolCall), title).toEqual({
-        server: "t3-code",
+        server: "goat",
         tool: "delegate_task",
       });
     }
@@ -1566,14 +1566,14 @@
       status: "in_progress",
       _meta: {
         goose: {
-          toolCall: { toolName: "t3-code__task_status", extensionName: "t3-code" },
+          toolCall: { toolName: "goat__task_status", extensionName: "goat" },
           messageId: "message-1",
         },
       },
     });

     expect(extractMcpToolCallIdentity(toolCall)).toEqual({
-      server: "t3-code",
+      server: "goat",
       tool: "task_status",
     });
   });
@@ -1588,12 +1588,12 @@
       kind: "other",
       title: "unrelated display title",
       status: "pending",
-      _meta: { toolName: "mcp::t3-code::goat_thread_send", serverId: "t3-code", provenance: "mcp" },
+      _meta: { toolName: "mcp::goat::goat_thread_send", serverId: "goat", provenance: "mcp" },
     });

     expect(extractMcpToolCallIdentity(toolCall)).toEqual({
-      server: "t3-code",
+      server: "goat",
       tool: "goat_thread_send",
     });
   });

@@ -1639,7 +1639,7 @@
       sessionUpdate: "tool_call",
       toolCallId: "foreign-1",
       kind: "other",
-      title: "t3-code_delegate_task",
+      title: "goat_delegate_task",
       status: "pending",
       _meta: { toolName: "delegate_task", serverId: "other-orchestrator" },
     });
@@ -1650,8 +1650,43 @@
     });
   });

+  it.each(["goat-house", "other-orchestrator"])(
+    "keeps an asserted foreign origin despite a goat title: %s",
+    (serverId) => {
+      const toolCall = toolCallFromUpdate({
+        sessionUpdate: "tool_call",
+        toolCallId: "foreign-goat-title",
+        kind: "other",
+        title: "goat_delegate_task",
+        status: "pending",
+        _meta: { serverId, toolName: "delegate_task" },
+      });
+      expect(extractMcpToolCallIdentity(toolCall)).toEqual({ server: serverId, tool: "delegate_task" });
+    },
+  );
+
+  it("recognizes the trimmed goat origin while preserving foreign qualified names", () => {
+    const toolCall = toolCallFromUpdate({
+      sessionUpdate: "tool_call",
+      toolCallId: "goat-origin",
+      kind: "other",
+      title: "Rewritten title",
+      status: "pending",
+      _meta: { serverId: " GOAT ", toolName: "mcp::goat::goat_thread_send" },
+    });
+    expect(extractMcpToolCallIdentity(toolCall)).toEqual({ server: "goat", tool: "goat_thread_send" });
+    const foreign = toolCallFromUpdate({
+      sessionUpdate: "tool_call",
+      toolCallId: "foreign-qualified-goat-tool",
+      kind: "other",
+      title: "mcp__weather__delegate_task",
+      status: "pending",
+    });
+    expect(extractMcpToolCallIdentity(foreign)).toEqual({ server: "weather", tool: "delegate_task" });
+  });
+
   it("does not brand path-like or unknown-tool titles", () => {
-    for (const title of ["t3-code/README.md", "t3-code_not_a_real_tool"]) {
+    for (const title of ["goat/README.md", "goat_not_a_real_tool"]) {
       const toolCall = toolCallFromUpdate({
         sessionUpdate: "tool_call",
         toolCallId: "path-1",
```

### MODIFY `packages/provider-acp/src/server/mcpOverAcpBridge.test.ts`

The bridge accepts goat only; reject both an unknown origin and the retired registration key before allocating a connection.

```diff
--- a/packages/provider-acp/src/server/mcpOverAcpBridge.test.ts
+++ b/packages/provider-acp/src/server/mcpOverAcpBridge.test.ts
@@ -44,7 +44,7 @@
         },
       });

-      const connected = yield* bridge.connect({ serverId: "t3-code" });
+      const connected = yield* bridge.connect({ serverId: "goat" });
       expect(connected).toEqual({ connectionId: "connection-1" });
       expect(
         yield* bridge.message({ connectionId: connected.connectionId, method: "initialize" }),
@@ -79,7 +79,7 @@
           return new Promise<Response>(() => {});
         },
       });
-      const connected = yield* bridge.connect({ serverId: "t3-code" });
+      const connected = yield* bridge.connect({ serverId: "goat" });
       const request = yield* bridge
         .message({ connectionId: connected.connectionId, method: "tools/list" })
         .pipe(Effect.forkChild);
@@ -98,14 +98,16 @@
         fetchImplementation: () => Promise.resolve(new Response(null, { status: 202 })),
       });

-      expect(yield* bridge.connect({ serverId: "other" }).pipe(Effect.flip)).toMatchObject({
-        _tag: "AcpMcpOverAcpError",
-      });
+      for (const serverId of ["other", "t3-code"]) {
+        expect(yield* bridge.connect({ serverId }).pipe(Effect.flip)).toMatchObject({
+          _tag: "AcpMcpOverAcpError",
+        });
+      }
       expect(
         yield* bridge.message({ connectionId: "missing", method: "tools/list" }).pipe(Effect.flip),
       ).toMatchObject({ _tag: "AcpMcpOverAcpError" });

-      const connected = yield* bridge.connect({ serverId: "t3-code" });
+      const connected = yield* bridge.connect({ serverId: "goat" });
       const failure = yield* bridge
         .message({
           connectionId: connected.connectionId,
```

### MODIFY `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`

Final allowlist is mcp__goat__goat_* for wp3-renamed tools and mcp__goat__<unchanged-tool> otherwise; read-only mode never gains wildcard.

```diff
--- a/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
+++ b/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
@@ -955,30 +955,30 @@
   return input.cwd === null ? withDirectories : { ...withDirectories, cwd: input.cwd };
 }

-export const CLAUDE_T3_MCP_TOOL_WILDCARD = "mcp__t3-code__*";
+export const CLAUDE_T3_MCP_TOOL_WILDCARD = "mcp__goat__*";

 // Must stay in sync with the Tool.Readonly annotations on OrchestratorToolkit;
 // ClaudeAdapterV2.test.ts cross-checks this list against the toolkit.
 export const CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS: ReadonlyArray<string> = [
-  "mcp__t3-code__orchestrator_capabilities",
-  "mcp__t3-code__list_scheduled_tasks",
-  "mcp__t3-code__goat_thread_list",
-  "mcp__t3-code__goat_thread_wait",
-  "mcp__t3-code__goat_pending_request_list",
-  "mcp__t3-code__goat_pending_request_read",
-  "mcp__t3-code__goat_thread_configuration",
-  "mcp__t3-code__goat_thread_transfers",
-  "mcp__t3-code__goat_worktree_status",
-  "mcp__t3-code__goat_worktree_list",
-  "mcp__t3-code__goat_project_list",
-  "mcp__t3-code__goat_project_read",
-  "mcp__t3-code__goat_thread_search",
-  "mcp__t3-code__goat_preview_list",
-  "mcp__t3-code__goat_environment_read",
-  "mcp__t3-code__goat_queue_list",
-  "mcp__t3-code__goat_queue_read",
-  "mcp__t3-code__html_preview",
-  "mcp__t3-code__html_render",
+  "mcp__goat__orchestrator_capabilities",
+  "mcp__goat__list_scheduled_tasks",
+  "mcp__goat__goat_thread_list",
+  "mcp__goat__goat_thread_wait",
+  "mcp__goat__goat_pending_request_list",
+  "mcp__goat__goat_pending_request_read",
+  "mcp__goat__goat_thread_configuration",
+  "mcp__goat__goat_thread_transfers",
+  "mcp__goat__goat_worktree_status",
+  "mcp__goat__goat_worktree_list",
+  "mcp__goat__goat_project_list",
+  "mcp__goat__goat_project_read",
+  "mcp__goat__goat_thread_search",
+  "mcp__goat__goat_preview_list",
+  "mcp__goat__goat_environment_read",
+  "mcp__goat__goat_queue_list",
+  "mcp__goat__goat_queue_read",
+  "mcp__goat__html_preview",
+  "mcp__goat__html_render",
 ];

 // Claude Code aborts an HTTP MCP call after 60 s ("The operation timed out.")
@@ -989,7 +989,7 @@
 export const CLAUDE_T3_MCP_TOOL_TIMEOUT_MS = 65 * 60 * 1_000;

 // The SDK's `allowedTools` only pre-approves tool calls; availability is the
-// separate `tools` option. Attaching the t3-code MCP server therefore always
+// separate `tools` option. Attaching the goat MCP server therefore always
 // pre-approves its tools (headless modes like `dontAsk` deny anything that is
 // not pre-approved), but read-only sandboxes pre-approve only the annotated
 // read-only orchestrator tools so a read-only session cannot silently spawn
@@ -1020,7 +1020,7 @@
   return {
     allowedTools: Array.from(new Set([...(input.allowedTools ?? []), ...mcpAllowedTools])),
     mcpServers: {
-      "t3-code": {
+      "goat": {
         type: "http",
         url: session.endpoint,
         headers: {
```

### MODIFY `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`

Update query/mcpServers/wildcard and toolkit-annotation cross-check to the goat namespace. Existing tests cover credential rotation and read-only policy.

```diff
--- a/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
+++ b/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
@@ -471,7 +471,7 @@

 describe("ClaudeAdapterV2 MCP query overrides", () => {
   const T3_MCP_SERVERS = {
-    "t3-code": {
+    "goat": {
       type: "http",
       url: "http://127.0.0.1:43123/mcp",
       headers: {
@@ -516,7 +516,7 @@
     assert.deepEqual(overrides, { allowedTools: ["Read"] });
   });

-  it("pre-approves all t3-code tools when attaching an MCP session without an allowlist", () => {
+  it("pre-approves all goat tools when attaching an MCP session without an allowlist", () => {
     const threadId = ThreadId.make("thread-claude-mcp-no-allowlist");
     const mcpSession = mcpSessionFor(threadId);
     const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
@@ -531,23 +531,23 @@
     });
   });

-  it("extends an explicit allowlist with the t3-code wildcard", () => {
+  it("extends an explicit allowlist with the goat wildcard", () => {
     const threadId = ThreadId.make("thread-claude-mcp-with-allowlist");
     const mcpSession = mcpSessionFor(threadId);
     const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
       mcpSession,
       readOnlySandbox: false,
-      allowedTools: ["Read", "mcp__t3-code__*"],
+      allowedTools: ["Read", "mcp__goat__*"],
     });

     assert.deepEqual(overrides, {
-      allowedTools: ["Read", "mcp__t3-code__*"],
+      allowedTools: ["Read", "mcp__goat__*"],
       mcpServers: T3_MCP_SERVERS,
       mcpEnvironment: T3_MCP_ENVIRONMENT,
     });
   });

-  it("pre-approves only read-only t3-code tools in a read-only sandbox", () => {
+  it("pre-approves only read-only goat tools in a read-only sandbox", () => {
     const threadId = ThreadId.make("thread-claude-mcp-read-only");
     const mcpSession = mcpSessionFor(threadId);
     const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
@@ -567,7 +567,7 @@
     assert.isFalse(overrides.allowedTools?.includes(ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD));
   });

-  it("pre-approves only read-only t3-code tools in a read-only sandbox without an allowlist", () => {
+  it("pre-approves only read-only goat tools in a read-only sandbox without an allowlist", () => {
     const threadId = ThreadId.make("thread-claude-mcp-read-only-no-allowlist");
     const mcpSession = mcpSessionFor(threadId);
     const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
@@ -647,7 +647,7 @@
       ...Object.values(HtmlToolkit.tools),
     ]
       .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
-      .map((tool) => `mcp__t3-code__${tool.name}`)
+      .map((tool) => `mcp__goat__${tool.name}`)
       .sort();

     assert.deepEqual(
@@ -676,9 +676,9 @@
       allowedTools: ["Read"],
     });
     assert.deepEqual(overrides, {
-      allowedTools: ["Read", "mcp__t3-code__*"],
+      allowedTools: ["Read", "mcp__goat__*"],
       mcpServers: {
-        "t3-code": {
+        "goat": {
           type: "http",
           url: "http://127.0.0.1:43123/mcp",
           headers: {
```

### MODIFY `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts`

Test Codex wire registration, qualified projected names and resumed tool calls; temporary directory names remain unchanged.

```diff
--- a/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts
+++ b/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts
@@ -665,7 +665,7 @@
         config: {
           "tools.update_plan.enabled": true,
           mcp_servers: {
-            "t3-code": {
+            "goat": {
               url: "http://127.0.0.1:43123/mcp",
               http_headers: {
                 Authorization: "Bearer secret-codex-token",
@@ -968,7 +968,7 @@
       const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
         type: "mcpToolCall",
         id: "call-create-threads",
-        server: "t3-code",
+        server: "goat",
         tool: "create_threads",
         status: "completed",
         arguments: {
@@ -983,7 +983,7 @@
       });

       assert.deepEqual(projection, {
-        toolName: "t3-code.create_threads",
+        toolName: "goat.create_threads",
         input: {
           threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
         },
@@ -6856,7 +6856,7 @@
             item: {
               type: "mcpToolCall",
               id: COMPLETED_WAIT_ITEM,
-              server: "t3-code",
+              server: "goat",
               tool: "goat_thread_wait",
               status: "inProgress",
               arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
@@ -6876,7 +6876,7 @@
             item: {
               type: "mcpToolCall",
               id: COMPLETED_WAIT_ITEM,
-              server: "t3-code",
+              server: "goat",
               tool: "goat_thread_wait",
               status: "completed",
               arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
@@ -6897,7 +6897,7 @@
             item: {
               type: "mcpToolCall",
               id: ORPHAN_WAIT_ITEM,
-              server: "t3-code",
+              server: "goat",
               tool: "goat_thread_wait",
               status: "inProgress",
               arguments: {
```

### MODIFY `apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts`

Assert goat in injected stdio server and projected tool identity for the shared ACP adapter.

```diff
--- a/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts
+++ b/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts
@@ -752,7 +752,7 @@

       const mcpServer = runtimeInput?.mcpServers[0];
       if (mcpServer === undefined || !("command" in mcpServer)) {
-        return yield* Effect.die("ACP runtime must receive the t3-code stdio MCP server");
+        return yield* Effect.die("ACP runtime must receive the goat stdio MCP server");
       }
       assert.equal(mcpServer.command, process.execPath);
       assert.deepEqual(mcpServer.args, ["acp-mcp-bridge"]);
@@ -1410,7 +1410,7 @@
           (item) =>
             item.threadId === task?.childThreadId &&
             item.type === "dynamic_tool" &&
-            item.toolName === "t3-code.task_status",
+            item.toolName === "goat.task_status",
         ),
       );
       const childMcp = items.find(
@@ -2264,7 +2264,7 @@
         mcpServers: [
           {
             type: "stdio",
-            name: "t3-code",
+            name: "goat",
             command: process.execPath,
             args: [
               process.argv[1] === undefined ? "t3" : NodePath.resolve(process.argv[1]),
```

### MODIFY `packages/provider-opencode/src/server/v2/adapter.ts`

Keep directory registration and same-name cleanup; digest raw ids whenever sanitization is lossy or the name is over 64 characters. Deny legacy names before allowing the current goat thread; record the pre-existing wildcard-overlap residual separately.

```diff
--- a/packages/provider-opencode/src/server/v2/adapter.ts
+++ b/packages/provider-opencode/src/server/v2/adapter.ts
@@ -450,20 +450,22 @@
  */
 /**
  * T3's MCP server is registered per directory, not per session, so each thread
- * gets its own `t3-code-<thread>` entry with its own credential. OpenCode names
+ * gets its own `goat-<thread>` entry with its own credential. OpenCode names
  * an MCP tool's permission `<server>_<tool>` (non-alphanumerics become `_`).
  * OpenCode skips every tool of a server whose name is over 64 characters (its
  * tool namespace limit), and its router rejects adding one over 100, so a
- * thread id that does not fit is replaced by a digest of it.
+ * thread id that does not fit, or whose sanitization is lossy, is replaced by
+ * a digest of the original id so shortening the prefix cannot merge names.
  */
 export const t3McpServerName = Effect.fn("t3McpServerName")(function* (threadId: string) {
-  const name = `t3-code-${threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
-  if (name.length <= 64) return name;
+  const sanitized = threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
+  const name = `goat-${sanitized}`;
+  // Keep the readable-id ceiling the t3-code- prefix had (56), so a shorter
+  // prefix never makes more ids readable and widens own-thread wildcards.
+  if (sanitized === threadId && sanitized.length <= 56) return name;
   const crypto = yield* Crypto.Crypto;
   const digest = yield* crypto
     .digest("SHA-256", new TextEncoder().encode(threadId))
     .pipe(Effect.orDie);
-  return `t3-code-${Hex.encode(digest).slice(0, 16)}`;
+  return `goat-${Hex.encode(digest).slice(0, 16)}`;
 });

 /**
@@ -476,7 +478,9 @@
   mcpServerName === null
     ? []
     : [
+        // A reused daemon can still carry registrations from before the rename.
         { action: "t3-code-*", resource: "*", effect: "deny" },
+        { action: "goat-*", resource: "*", effect: "deny" },
         { action: `${mcpServerName}_*`, resource: "*", effect: "allow" },
       ];

@@ -657,7 +661,7 @@

 const INTERRUPT_TIMEOUT = "10 seconds";
 /** The session instructions entry T3 writes its per-turn system prompt to. */
-const INSTRUCTIONS_KEY = "t3-code";
+const INSTRUCTIONS_KEY = "goat";
 /** A lost event stream is resubscribed this many times, this far apart, before the session breaks. */
 const RECONNECT_ATTEMPTS = 5;
 const RECONNECT_DELAY = "2 seconds";
```

### MODIFY `apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts`

Replay registration and symmetric removal, dual namespace deny rules and own-thread allow, resume/fork policy, exact 64-character lossless boundary and distinct digests for the 59-character lossy collision pair. Keep lossy-id permission expectations consistent; wildcard overlap is a pre-existing residual.

```diff
--- a/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts
+++ b/apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts
@@ -76,7 +76,8 @@
 /** The rules T3 gives every session it runs, with only this thread's own T3 MCP server allowed. */
 const mcpRules = [
   { action: "t3-code-*", resource: "*", effect: "deny" },
-  { action: "t3-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
+  { action: "goat-*", resource: "*", effect: "deny" },
+  { action: "goat-c26f2f1fb6fbbcc2_*", resource: "*", effect: "allow" },
 ];
 const t3Rules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];
 /** The thread's title, which the recorded session already carries. */
@@ -174,7 +175,7 @@
         ...entries.slice(0, at),
         out("session.instructions.entry.put", {
           sessionID: SESSION,
-          key: "t3-code",
+          key: "goat",
           value: "<any>",
         }),
         reply("session.instructions.entry.put", null),
@@ -2749,7 +2750,7 @@
           browserToolsAvailable: false,
         });
         yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));
-        const server = "t3-code-thread_opencode2-adapter";
+        const server = "goat-c26f2f1fb6fbbcc2";
         const { runtime, thread } = yield* resumed([
           // Registered for the session's directory under the thread's own name;
           // the session's rules allow only this name's tools (see `t3Rules`).
@@ -2783,7 +2784,7 @@
       const child = ThreadId.make(
         "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Asubproject-b-round1",
       );
-      const server = "t3-code-aa73fa1e03099934";
+      const server = "goat-aa73fa1e03099934";
       const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
       yield* mcpSessions.set({
         environmentId: EnvironmentId.make("environment:opencode2-adapter"),
@@ -2805,6 +2806,7 @@
             permissions: [
               { action: "*", resource: "*", effect: "allow" },
               { action: "t3-code-*", resource: "*", effect: "deny" },
+              { action: "goat-*", resource: "*", effect: "deny" },
               { action: `${server}_*`, resource: "*", effect: "allow" },
             ],
           }),
@@ -2850,14 +2852,89 @@
         "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Around2",
       ];
       const names = yield* Effect.forEach(ids, t3McpServerName);
-      for (const name of names) assert.match(name, /^t3-code-[A-Za-z0-9_-]{1,56}$/);
+      for (const name of names) assert.match(name, /^goat-[A-Za-z0-9_-]{1,59}$/);
       assert.equal(new Set(names).size, ids.length);
       assert.deepEqual(yield* Effect.forEach(ids, t3McpServerName), names);
       // A digested name is the one the synchronous node:crypto version produced.
-      assert.equal(names[0], "t3-code-63abb5df2b188bdd");
-      // A name that already fits stays readable.
-      assert.equal(yield* t3McpServerName(threadId), "t3-code-thread_opencode2-adapter");
+      assert.equal(names[0], "goat-63abb5df2b188bdd");
+      // Lossy sanitization hashes the original id even when its name fits.
+      assert.equal(yield* t3McpServerName(threadId), "goat-c26f2f1fb6fbbcc2");
+      // Lossless ids stay readable; the cap includes the five-character "goat-" prefix.
+      assert.equal(yield* t3McpServerName("thread_opencode2-adapter"), "goat-thread_opencode2-adapter");
+      assert.equal((yield* t3McpServerName("x".repeat(59))).length, 64);
+      assert.match(yield* t3McpServerName("x".repeat(60)), /^goat-[a-f0-9]{16}$/);
     }).pipe(Effect.provide(NodeCrypto.layer)),
+  );
+
+  it.effect("registers distinct MCP names for thread ids that sanitize to the same 64-character name", () =>
+    Effect.gen(function* () {
+      const ids = [
+        ThreadId.make(`thread:${"x".repeat(49)}a:b`),
+        ThreadId.make(`thread:${"x".repeat(49)}a_b`),
+      ];
+      const names = yield* Effect.forEach(ids, t3McpServerName);
+      // Both raw ids have length 59 and collapse to the same readable goat name.
+      assert.deepEqual(names, ["goat-a8a5047e3b3ef95f", "goat-84c3953c7ac1e4ef"]);
+      const registered = yield* Effect.forEach(ids, (child, index) =>
+        Effect.gen(function* () {
+          const server = names[index]!;
+          const credential = `Bearer thread-credential-${index}`;
+          const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
+          yield* mcpSessions.set({
+            environmentId: EnvironmentId.make("environment:opencode2-adapter"),
+            threadId: child,
+            providerSessionId: `mcp:collision-${index}`,
+            providerInstanceId: instanceId,
+            endpoint: "http://127.0.0.1:3773/mcp",
+            authorizationHeader: credential,
+            browserToolsAvailable: false,
+          });
+          yield* Effect.addFinalizer(() => mcpSessions.clear(child));
+          const runtime = yield* openCode2ReplayRuntimeWithInstructions([
+            ...opening,
+            out("session.get", { sessionID: SESSION }),
+            replyData("session.get", sessionInfo({
+              permissions: [
+                { action: "*", resource: "*", effect: "allow" },
+                { action: "t3-code-*", resource: "*", effect: "deny" },
+                { action: "goat-*", resource: "*", effect: "deny" },
+                { action: `${server}_*`, resource: "*", effect: "allow" },
+              ],
+            })),
+            ...noOpenRequests,
+            out("mcp.add", {
+              server,
+              "location[directory]": WORK,
+              config: {
+                type: "remote",
+                url: "http://127.0.0.1:3773/mcp",
+                headers: { Authorization: credential },
+                oauth: false,
+              },
+            }),
+            reply("mcp.add", null),
+            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
+            promptAccepted,
+            event("session.execution.succeeded", { sessionID: SESSION }),
+            out("mcp.remove", { server, "location[directory]": WORK }),
+            reply("mcp.remove", null),
+          ]);
+          const thread = yield* runtime.resumeThread({
+            providerThread: { ...providerThread(yield* DateTime.now), appThreadId: child },
+            threadId: child,
+            modelSelection: bigPickle,
+            runtimePolicy: policy(),
+          });
+          const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
+          yield* runtime.startTurn({ ...turnInput(thread), threadId: child });
+          assert.equal((yield* Fiber.join(terminal))?.status, "completed");
+          yield* runtime.unloadThread!({ providerThread: thread });
+          // Reaching here proves the HTTP replay consumed this add/remove pair.
+          return server;
+        }).pipe(Effect.scoped),
+      );
+      assert.notEqual(registered[0], registered[1]);
+    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
   );

   it.effect("reads user and assistant text from the session's message list", () =>
@@ -3210,7 +3287,7 @@
         ...promptInto(SESSION, "msg_recorded_turn_a"),
         ...steerInto(SESSION, "msg_recorded_steer_a"),
         // The other session gets its own instructions entry before its first prompt.
-        out("session.instructions.entry.put", { sessionID: OTHER, key: "t3-code", value: "<any>" }),
+        out("session.instructions.entry.put", { sessionID: OTHER, key: "goat", value: "<any>" }),
         reply("session.instructions.entry.put", null),
         ...promptInto(OTHER, "msg_recorded_turn_b"),
         ...steerInto(OTHER, "msg_recorded_steer_b"),
@@ -3754,7 +3831,8 @@
           permissions: [
             { action: "*", resource: "*", effect: "allow" },
             { action: "t3-code-*", resource: "*", effect: "deny" },
-            { action: "t3-code-thread_opencode2-adapter_fork_*", resource: "*", effect: "allow" },
+            { action: "goat-*", resource: "*", effect: "deny" },
+            { action: "goat-7c81f4ba96860743_*", resource: "*", effect: "allow" },
           ],
         }),
         reply("session.update", null),
```

### MODIFY `apps/server/src/orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts`

Replay registration and symmetric removal, dual namespace deny rules and own-thread allow, resume/fork policy, exact 64-character lossless boundary and distinct digests for the 59-character lossy collision pair. Keep lossy-id permission expectations consistent; wildcard overlap is a pre-existing residual.

```diff
--- a/apps/server/src/orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts
+++ b/apps/server/src/orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts
@@ -3,6 +3,7 @@
  * the transcript fixes the order of every request the adapter sends, so a
  * request the orchestrator never lets it make fails the run.
  */
+import { createHash } from "node:crypto";
 import * as NodeServices from "@effect/platform-node/NodeServices";
 import { assert, describe, it } from "@effect/vitest";
 import {
@@ -77,7 +78,12 @@
  */
 const mcpRules = (name: string) => [
   { action: "t3-code-*", resource: "*", effect: "deny" },
-  { action: `t3-code-thread_${name}_*`, resource: "*", effect: "allow" },
+  { action: "goat-*", resource: "*", effect: "deny" },
+  {
+    action: `goat-${createHash("sha256").update(`thread:${name}`).digest("hex").slice(0, 16)}_*`,
+    resource: "*",
+    effect: "allow",
+  },
 ];
 const FULL_ACCESS = [{ action: "*", resource: "*", effect: "allow" }];
 /** Full access for the thread named `name`. */
@@ -166,7 +172,7 @@
 });
 /** T3's instructions entry, written before a thread's first prompt and whenever it changes. */
 const instructionsWritten: ReadonlyArray<ProviderReplayEntry> = [
-  out("session.instructions.entry.put", { sessionID: SESSION, key: "t3-code", value: "<any>" }),
+  out("session.instructions.entry.put", { sessionID: SESSION, key: "goat", value: "<any>" }),
   reply("session.instructions.entry.put", null),
 ];
 /** One prompt the server accepts and answers with `text`. */
```

### MODIFY `packages/provider-pi/src/server/mcpExtensionSource.ts`

Exactly one callable registration per catalog item. Preserve pre-builtin ownership, direct/deferred discovery, cancellation, retry and permissions; no hidden duplicate.

```diff
--- a/packages/provider-pi/src/server/mcpExtensionSource.ts
+++ b/packages/provider-pi/src/server/mcpExtensionSource.ts
@@ -297,7 +297,7 @@
   if (endpoint === undefined || token === undefined) {
     pi.on("session_start", async (_event, ctx) => {
       ctx.ui.notify(
-        "t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.",
+        "goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.",
         "warning",
       );
     });
@@ -315,35 +315,31 @@
   let started: Promise<void> | undefined;

   const registerTools = () => {
-    // Preserve public names for saved loadouts and tool selectors. Hidden
-    // canonical names reserve ownership against Pi's configured MCP servers.
-    const prefixes = supportsExposure ? ["mcp__t3-code__", "mcp__t3_code__"] : ["mcp__t3-code__"];
+    // The public and normalized goat namespaces are identical. One registration
+    // reserves ownership without a hidden alias shadowing the callable tool.
     for (const tool of catalog) {
       const name = tool.name;
-      for (const prefix of prefixes) {
-        const exposure = prefix === "mcp__t3_code__" ? "hidden" :
-          deferOptionalTools && !directTools.has(name) ? "deferred" : "direct";
-        pi.registerTool({
-          name: \`\${prefix}\${name}\`,
-          label: name,
-          description: tool.description ?? name,
-          parameters: jsonSchemaToTypebox(tool.inputSchema),
-          ...(supportsExposure ? { exposure } : {}),
-          async execute(_toolCallId, params, signal) {
-            const result = await client.callTool(
-              name,
-              (params ?? {}) as Record<string, unknown>,
-              signal,
-            );
-            const text = formatMcpContent(result);
-            return {
-              content: [{ type: "text", text }],
-              details: { server: "t3-code", tool: name },
-              ...(isMcpToolError(result) ? { isError: true } : {}),
-            };
-          },
-        });
-      }
+      const exposure = deferOptionalTools && !directTools.has(name) ? "deferred" : "direct";
+      pi.registerTool({
+        name: \`mcp__goat__\${name}\`,
+        label: name,
+        description: tool.description ?? name,
+        parameters: jsonSchemaToTypebox(tool.inputSchema),
+        ...(supportsExposure ? { exposure } : {}),
+        async execute(_toolCallId, params, signal) {
+          const result = await client.callTool(
+            name,
+            (params ?? {}) as Record<string, unknown>,
+            signal,
+          );
+          const text = formatMcpContent(result);
+          return {
+            content: [{ type: "text", text }],
+            details: { server: "goat", tool: name },
+            ...(isMcpToolError(result) ? { isError: true } : {}),
+          };
+        },
+      });
     }
   };

@@ -363,7 +359,7 @@
   };

   // CLI extensions load before builtins, and Pi keeps the first registration
-  // of a tool name. Register now so the bridge owns the T3 namespace even when
+  // of a tool name. Register now so the bridge owns the GOAT namespace even when
   // mcp.json configures it; retry a failed connection at session_start.
   await ensureStarted().catch(() => undefined);

@@ -388,7 +384,7 @@
       await ensureStarted();
     } catch (error) {
       const message = error instanceof Error ? error.message : String(error);
-      ctx.ui.notify(\`t3-code MCP unavailable: \${message}\`, "warning");
+      ctx.ui.notify(\`goat MCP unavailable: \${message}\`, "warning");
     }
   });

```

### MODIFY `packages/provider-pi/src/server/mcpExtensionSource.test.ts`

Execute generated Pi extension, count registration attempts before the mock deduplicates, verify discovery and raw HTTP tool name, and retain selected/excluded tool/approval behavior.

```diff
--- a/packages/provider-pi/src/server/mcpExtensionSource.test.ts
+++ b/packages/provider-pi/src/server/mcpExtensionSource.test.ts
@@ -60,6 +60,7 @@
     signal?: AbortSignal,
   ) => Promise<{
     readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
+    readonly details: { readonly server: string; readonly tool: string };
   }>;
 }

@@ -74,10 +75,12 @@
     readonly toolSearchAvailable?: boolean;
     readonly toolSearchDisabled?: boolean;
     readonly allowsTool?: (name: string) => boolean;
+    readonly catalog?: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
   } = {},
 ) {
   const handlers = new Map<string, AgentStartHook>();
   const tools: RegisteredTool[] = [];
+  const registrations: string[] = [];
   const requests: Array<{ readonly method: string; readonly params?: unknown }> = [];
   let activeTools = ["read"];
   const transports: Array<{
@@ -86,12 +89,12 @@
     readonly signal: AbortSignal | undefined;
   }> = [];
   const servers: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
-  const catalog = [
+  const catalog = (options.catalog ?? [
     { name: "orchestrator_capabilities", description: "Discover available providers and models." },
     { name: "delegate_task", description: "Delegate work to another agent." },
     { name: "task_status", description: "Check delegated work." },
     { name: "preview_snapshot", description: "Inspect the collaborative browser." },
-  ].map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } }));
+  ]).map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } }));
   const source = NodeModule.stripTypeScriptTypes(
     PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
       "export default async function",
@@ -128,6 +131,7 @@
     pi: {
       on: (name: string, handler: AgentStartHook) => handlers.set(name, handler),
       registerTool: (tool: RegisteredTool) => {
+        registrations.push(tool.name);
         if (options.allowsTool && !options.allowsTool(tool.name)) return;
         const index = tools.findIndex((current) => current.name === tool.name);
         if (index === -1) tools.push(tool);
@@ -155,6 +159,7 @@
   return {
     handlers,
     tools,
+    registrations,
     requests,
     servers,
     transports,
@@ -166,6 +171,25 @@
 }

 describe("Pi MCP tool exposure", () => {
+  it("calls a wp3-renamed tool through one goat namespace without rewriting its bare id", async () => {
+    const bridge = await loadMcpBridge({
+      modern: true,
+      toolSearchAvailable: true,
+      catalog: [{ name: "goat_thread_read", description: "Read a GOAT thread." }],
+    });
+    assert.deepEqual(bridge.registrations, ["mcp__goat__goat_thread_read"]);
+    const tool = bridge.tools.find((tool) => tool.name === "mcp__goat__goat_thread_read");
+    assert.isDefined(tool);
+    assert.equal(tool!.exposure, "deferred");
+    const result = await tool!.execute("goat-read", { threadId: "thread-goat" });
+    assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1)?.params)), {
+      name: "goat_thread_read", arguments: { threadId: "thread-goat" },
+    });
+    assert.deepEqual(JSON.parse(JSON.stringify(result.details)), {
+      server: "goat", tool: "goat_thread_read",
+    });
+  });
+
   it("keeps orchestration direct and optional bridge tools discoverable on modern Pi", async () => {
     const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
     await bridge.handlers.get("session_start")!(
@@ -180,32 +204,30 @@
     );
     assert.include(prompt.systemPrompt, "orchestrator_capabilities");
     assert.equal(bridge.servers.length, 0);
-    assert.equal(bridge.tools.length, 8);
+    assert.equal(bridge.tools.length, 4);
+    assert.equal(bridge.registrations.length, 4);
+    assert.equal(new Set(bridge.registrations).size, 4);
     assert.deepEqual(bridge.getActiveTools(), ["read", "tool_search"]);
     assert.deepEqual(
       bridge.tools
         .filter((tool) => tool.exposure !== "hidden")
         .map((tool) => [tool.name, tool.exposure]),
       [
-        ["mcp__t3-code__orchestrator_capabilities", "direct"],
-        ["mcp__t3-code__delegate_task", "direct"],
-        ["mcp__t3-code__task_status", "direct"],
-        ["mcp__t3-code__preview_snapshot", "deferred"],
+        ["mcp__goat__orchestrator_capabilities", "direct"],
+        ["mcp__goat__delegate_task", "direct"],
+        ["mcp__goat__task_status", "direct"],
+        ["mcp__goat__preview_snapshot", "deferred"],
       ],
     );
-    assert.deepEqual(
-      bridge.tools.filter((tool) => tool.exposure === "hidden").map((tool) => tool.name),
-      [
-        "mcp__t3_code__orchestrator_capabilities",
-        "mcp__t3_code__delegate_task",
-        "mcp__t3_code__task_status",
-        "mcp__t3_code__preview_snapshot",
-      ],
-    );
+    assert.deepEqual(bridge.tools.filter((tool) => tool.exposure === "hidden"), []);
     const result = await bridge.tools
-      .find((tool) => tool.name === "mcp__t3-code__preview_snapshot")!
+      .find((tool) => tool.name === "mcp__goat__preview_snapshot")!
       .execute("call-1", { depth: 2 });
     assert.equal(result.content[0]?.text, "browser snapshot");
+    assert.deepEqual(JSON.parse(JSON.stringify(result.details)), { server: "goat", tool: "preview_snapshot" });
+    assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1)?.params)), {
+      name: "preview_snapshot", arguments: { depth: 2 },
+    });
     assert.equal(bridge.requests.at(-1)?.method, "tools/call");
   });

@@ -227,7 +249,7 @@
           .filter((tool) => tool.exposure !== "hidden")
           .every((tool) => tool.exposure === undefined || tool.exposure === "direct"),
       );
-      const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot");
+      const tool = bridge.tools.find((tool) => tool.name === "mcp__goat__preview_snapshot");
       assert.isDefined(tool);
       const controller = new AbortController();
       const result = await tool!.execute("call-1", { depth: 2 }, controller.signal);
@@ -246,12 +268,12 @@
     },
   );

-  it("preserves legacy wildcard tool selection", async () => {
+  it("honors goat wildcard tool selection", async () => {
     const bridge = await loadMcpBridge({
       modern: true,
       toolSearchAvailable: true,
       allowsTool: (name) =>
-        name === "read" || name === "tool_search" || name.startsWith("mcp__t3-code__"),
+        name === "read" || name === "tool_search" || name.startsWith("mcp__goat__"),
     });
     await bridge.handlers.get("session_start")!(
       { systemPrompt: "" },
@@ -259,7 +281,7 @@
     );
     assert.equal(bridge.tools.length, 4);
     assert.equal(bridge.tools.filter((tool) => tool.exposure === "direct").length, 3);
-    const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot");
+    const tool = bridge.tools.find((tool) => tool.name === "mcp__goat__preview_snapshot");
     assert.isDefined(tool);
     assert.equal((await tool!.execute("selected", {})).content[0]?.text, "browser snapshot");
   });
@@ -271,7 +293,7 @@
         modern: true,
         toolSearchAvailable: true,
         allowsTool: (name) =>
-          name !== "mcp__t3-code__delegate_task" && (!excludeSearch || name !== "tool_search"),
+          name !== "mcp__goat__delegate_task" && (!excludeSearch || name !== "tool_search"),
       });
       await bridge.handlers.get("session_start")!(
         { systemPrompt: "" },
@@ -279,16 +301,16 @@
       );
       bridge.restoreActiveTools([
         "read",
-        "mcp__t3-code__task_status",
-        "mcp__t3-code__preview_snapshot",
+        "mcp__goat__task_status",
+        "mcp__goat__preview_snapshot",
       ]);
       const tree = bridge.handlers.get("session_tree");
       assert.isDefined(tree);
       await tree!({ systemPrompt: "" }, { ui: { notify: () => undefined } });
       assert.deepEqual(bridge.getActiveTools(), [
         "read",
-        "mcp__t3-code__task_status",
-        "mcp__t3-code__preview_snapshot",
+        "mcp__goat__task_status",
+        "mcp__goat__preview_snapshot",
         ...(!excludeSearch ? ["tool_search"] : []),
       ]);
       assert.isFalse(
@@ -337,9 +359,9 @@
       await toolCall!({ toolName: "tool_search", input: { query: "preview_snapshot" } }, ctx),
     );
     assert.equal(confirmations.length, 0);
-    const result = await toolCall!({ toolName: "mcp__t3-code__preview_snapshot", input: {} }, ctx);
+    const result = await toolCall!({ toolName: "mcp__goat__preview_snapshot", input: {} }, ctx);
     assert.equal(result?.block, true);
-    assert.deepEqual(confirmations, ["Allow mcp__t3-code__preview_snapshot?"]);
+    assert.deepEqual(confirmations, ["Allow mcp__goat__preview_snapshot?"]);

     // An extension that replaces the search builtin is not known to be read-only.
     searchPath = "/extensions/custom-search.ts";
```

### MODIFY `packages/provider-pi/src/server/mcpInjection.test.ts`

Remove source-string assertions that would mirror prefix implementation; the generated-extension execution test above proves the behavior.

```diff
--- a/packages/provider-pi/src/server/mcpInjection.test.ts
+++ b/packages/provider-pi/src/server/mcpInjection.test.ts
@@ -161,8 +161,6 @@
       assert.include(mcpSource, "Allow ${event.toolName}?");
       assert.include(mcpSource, '"mcp-protocol-version"');
       assert.include(mcpSource, '"tools/call"');
-      assert.include(mcpSource, "mcp__t3-code__");
-      assert.include(mcpSource, "mcp__t3_code__");
     }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
   );
 });
```

### MODIFY `packages/shared/src/t3McpToolPresentation.ts`

Required reader-side companion to D6: add goat without deleting old namespace aliases or changing logo/icon identities. wp3 owns bare goat_* inventory aliases.

```diff
--- a/packages/shared/src/t3McpToolPresentation.ts
+++ b/packages/shared/src/t3McpToolPresentation.ts
@@ -82,7 +82,7 @@
   return { displayName, labels, icon, summaryAction };
 }

-const T3_MCP_SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code"]);
+const T3_MCP_SERVER_ALIASES = new Set(["goat", "t3-code", "t3_code", "t3code"]);

 // Cards, activity rows, summaries, and provider identity recovery share this inventory.
 const T3_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
@@ -406,7 +406,7 @@

 /**
  * ACP agents disagree on how the injected T3 server prefixes its tools:
- * `mcp__t3-code__x` (Claude/Cursor), `t3-code.x` (Codex), plus single
+ * `mcp__goat__x` (Claude/Cursor), `goat.x` (Codex), plus single
  * underscore, colon, slash, dash, and space separators seen from registry
  * agents. The prefix match is deliberately loose because the display-name
  * inventory is the real gate; unknown tools stay on the generic renderer.
@@ -423,20 +423,21 @@
       : null;
   }

-  const namespaceMatch = /^(?<server>t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
+  const namespaceMatch = /^(?<server>goat|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
     label,
   );
   if (namespaceMatch?.groups) {
     return namespaceMatch.groups.tool ?? null;
   }

-  const prefixed = /^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
+  const prefixed = /^(?:mcp[-_]{1,2})?(?:goat|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
   const candidate = prefixed?.groups?.tool ?? label;
   if (T3_MCP_TOOL_NAMES.has(candidate)) return candidate;
-  // OpenCode 2 registers one server per thread, `t3-code-<thread>`, and joins
+  // OpenCode 2 registers `goat-<thread>`; persisted `t3-code-<thread>` names
+  // remain readable. Each server joins
   // it to the tool with `_`. Thread ids can hold `_` too, so take the longest
   // known tool name that ends the label.
-  if (!/^t3-code-/i.test(label)) return null;
+  if (!/^(?:goat|t3-code)-/i.test(label)) return null;
   let longest: string | null = null;
   for (const tool of T3_MCP_TOOL_NAMES) {
     if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
```

### MODIFY `packages/shared/src/t3McpToolPresentation.test.ts`

Retain all old-history assertions and add every new namespace spelling plus per-thread and foreign/unknown rendering behavior.

```diff
--- a/packages/shared/src/t3McpToolPresentation.test.ts
+++ b/packages/shared/src/t3McpToolPresentation.test.ts
@@ -79,6 +79,13 @@
     for (const tool of T3_MCP_TOOL_NAMES) {
       const presentation = resolveT3McpToolPresentation(tool);
       for (const prefix of [
+        "mcp__goat__",
+        "goat.",
+        "goat/",
+        "goat:",
+        "goat · ",
+        "mcp_goat_",
+        "goat__",
         "mcp__t3-code__",
         "mcp__t3_code__",
         "mcp__t3code__",
@@ -159,6 +166,13 @@
     }
   });

+  it("renders goat names while leaving unknown and foreign tools generic", () => {
+    expect(resolveT3McpToolPresentation("goat-thread_child_1_delegate_task")?.displayName).toBe("Delegate a child task");
+    expect(resolveT3McpToolPresentation("goat-thread_child_1_not_a_tool")).toBeNull();
+    expect(resolveT3McpToolPresentation("mcp__weather__delegate_task")).toBeNull();
+    expect(resolveT3McpToolPresentation("mcp__goat__not_a_tool")).toBeNull();
+  });
+
   it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
     expect(
       resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")?.displayName,
```

### MODIFY `packages/shared/src/htmlRender.test.ts`

Verify rendered HTML attachments still resolve from goat qualified names and retained legacy names.

```diff
--- a/packages/shared/src/htmlRender.test.ts
+++ b/packages/shared/src/htmlRender.test.ts
@@ -157,6 +157,9 @@

   it("reads the reference from each provider's result envelope", () => {
     for (const [toolName, output] of [
+      ["mcp__goat__html_render", result],
+      ["goat.html_render", result],
+      ["goat-thread_1_html_render", result],
       ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
       ["t3-code.html_render", { structuredContent: result, content: [] }],
       ["t3-code-thread_1_html_render", JSON.stringify(result)],
```

### MODIFY `packages/provider-core/src/server/mcpToolPresentation.test.ts`

GOAT tools use product-owned presentation instead of acquiring a generic integration card; legacy history still behaves the same.

```diff
--- a/packages/provider-core/src/server/mcpToolPresentation.test.ts
+++ b/packages/provider-core/src/server/mcpToolPresentation.test.ts
@@ -57,6 +57,7 @@
       toolSource: { key: "mcp:my_server", name: "my server", kind: "integration" },
     });
     expect(mcpToolPresentation({ toolName: "Read" })).toEqual({});
+    expect(mcpToolPresentation({ serverName: "goat", toolName: "delegate_task" })).toEqual({});
     expect(mcpToolPresentation({ serverName: "t3-code", toolName: "delegate_task" })).toEqual({});
   });

```

### MODIFY `docs/orchestration-v2/orchestrator-mcp-server.md`

Correct the server key, Codex overrides and Claude wildcard, and replace obsolete Pi hidden-alias guidance with the single-registration/loadout contract.

```diff
--- a/docs/orchestration-v2/orchestrator-mcp-server.md
+++ b/docs/orchestration-v2/orchestrator-mcp-server.md
@@ -34,7 +34,7 @@
 http://127.0.0.1:<server-port>/mcp
```

-The provider-visible server key is `t3-code`. The endpoint registers both the
+The provider-visible server key is `goat`. The endpoint registers both the
preview toolkit and the orchestration toolkit.

Before `ProviderSessionManager` opens a new V2 provider session, it asks
@@ -62,8 +62,8 @@
overrides:

```text
--c mcp_servers.t3-code.url=http://127.0.0.1:<port>/mcp
--c mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"
+-c mcp_servers.goat.url=http://127.0.0.1:<port>/mcp
+-c mcp_servers.goat.bearer_token_env_var="T3_MCP_BEARER_TOKEN"
```

The provider-session token is placed in `T3_MCP_BEARER_TOKEN`. Both the
@@ -77,7 +77,7 @@

```ts
{
  mcpServers: {
-    "t3-code": {
+    "goat": {
      type: "http",
      url: "http://127.0.0.1:<port>/mcp",
      headers: {
@@ -87,7 +87,7 @@
  },
  allowedTools: [
    // existing allowed tools
-    "mcp__t3-code__*",
+    "mcp__goat__*",
  ],
}
```

@@ -159,10 +159,11 @@
T3_MCP_BEARER_TOKEN=<provider-session-token>

```

-The extension preserves public names under `mcp__t3-code__` for saved loadouts
-and tool selectors. Modern Pi also receives hidden `mcp__t3_code__` aliases,
-which reserve the normalized namespace against configured MCP servers without
-adding declarations or search results. On Pi 0.99+,
+The extension registers each tool once under `mcp__goat__`. The public and
+normalized names coincide, so no hidden alias is registered. Existing saved
+loadouts or tool selectors using `mcp__t3-code__` or `mcp__t3_code__` must be
+updated to `mcp__goat__`; the old names remain readable in history but are not
+registered for execution. On Pi 0.99+,
`orchestrator_capabilities`, `delegate_task`, and `task_status` remain directly
available; optional tools are discovered through Pi's builtin `tool_search`.
On older Pi or without builtin search, all tools remain directly available.
```

### MODIFY `docs/internals/providers.md`

Update the existing cross-thread isolation constraint, including the residual old-daemon risk.

```diff
--- a/docs/internals/providers.md
+++ b/docs/internals/providers.md
@@ -21,8 +21,8 @@
   after an idle period. See the [1.x adapter](../../packages/provider-opencode/src/server/adapter.ts).
 - **2.x** serves every directory from one
   [server per instance](../../packages/provider-opencode/src/server/v2/OpenCode2Server.ts). Each thread
-  registers its own `t3-code-<thread>` MCP entry, and session permission rules deny every other
-  thread's entry. See the [2.x adapter](../../packages/provider-opencode/src/server/v2/adapter.ts).
+  registers its own `goat-<thread>` MCP entry. Session permission rules deny every other
+  thread's entry and legacy `t3-code-*` entries left on a reused daemon. See the [2.x adapter](../../packages/provider-opencode/src/server/v2/adapter.ts).

 External OpenCode servers remain externally owned and can require an external restart to pick up
 configuration changes. OpenCode stores "always" approval grants for the whole project. Automatic
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/grok_auto_blocked_command/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/grok_auto_blocked_command/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/grok_auto_blocked_command/grok_transcript.ndjson
@@ -29,4 +29,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7-build-fast","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790383223057,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nThis is a permission test. Run exactly these two shell commands, one at a time, each as its own tool call:\n1. echo grok-auto-routine-ok\n2. rm -rf ~/grok-auto-probe-does-not-exist\nThe second path does not exist. Do not run anything else, then reply exactly: permission test done\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nThis is a permission test. Run exactly these two shell commands, one at a time, each as its own tool call:\n1. echo grok-auto-routine-ok\n2. rm -rf ~/grok-auto-probe-does-not-exist\nThe second path does not exist. Do not run anything else, then reply exactly: permission test done\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nThis is a permission test. Run exactly these two shell commands, one at a time, each as its own tool call:\n1. echo grok-auto-routine-ok\n2. rm -rf ~/grok-auto-probe-does-not-exist\nThe second path does not exist. Do not run anything else, then reply exactly: permission test done\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nThis is a permission test. Run exactly these two shell commands, one at a time, each as its own tool call:\n1. echo grok-auto-routine-ok\n2. rm -rf ~/grok-auto-probe-does-not-exist\nThe second path does not exist. Do not run anything else, then reply exactly: permission test done\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7-build-fast","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash/grok_transcript.ndjson
@@ -29,4 +29,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7-build-fast","reasoningEffort":"high","yolo":true,"activity":"working","resident":true,"lastChangeUnixMs":1790405167462,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nStart this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nStart this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nStart this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nStart this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7-build-fast","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash_fast_wake/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash_fast_wake/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash_fast_wake/grok_transcript.ndjson
@@ -32,4 +32,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7-build-fast","reasoningEffort":"high","yolo":true,"activity":"working","resident":true,"lastChangeUnixMs":1790806313459,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nStart this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nStart this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nStart this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nStart this shell command as a background task (run it in the background, do not wait for it, do not use the Monitor tool): 'for i in 1 2 3; do sleep 8; echo tock $i; done'. As soon as it has started, end your turn by replying exactly ROOT_DONE. When it finishes, reply exactly with its last line.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-4.7-build-fast. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/session_notification:hook_run_started","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"hook_run_started","event_name":"user_prompt_submit","prompt_id":"t3-xai-prompt-1","count":1},"_meta":{"agentTimestampMs":1790806313470}}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/grok_background_subagent/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/grok_background_subagent/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/grok_background_subagent/grok_transcript.ndjson
@@ -25,4 +25,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790321078856,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nSpawn one background subagent (run it in the background, do not wait for it) whose task is: run the shell command 'sleep 20' and then reply exactly SUBAGENT_DONE. As soon as the subagent is launched, end your turn by replying exactly ROOT_DONE without waiting for it.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nSpawn one background subagent (run it in the background, do not wait for it) whose task is: run the shell command 'sleep 20' and then reply exactly SUBAGENT_DONE. As soon as the subagent is launched, end your turn by replying exactly ROOT_DONE without waiting for it.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nSpawn one background subagent (run it in the background, do not wait for it) whose task is: run the shell command 'sleep 20' and then reply exactly SUBAGENT_DONE. As soon as the subagent is launched, end your turn by replying exactly ROOT_DONE without waiting for it.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nSpawn one background subagent (run it in the background, do not wait for it) whose task is: run the shell command 'sleep 20' and then reply exactly SUBAGENT_DONE. As soon as the subagent is launched, end your turn by replying exactly ROOT_DONE without waiting for it.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/grok_monitor/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/grok_monitor/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/grok_monitor/grok_transcript.ndjson
@@ -25,4 +25,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790319032095,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nUse the Monitor tool to watch this command: 'for i in 1 2 3; do sleep 8; echo tick $i; done'. Do not wait for the monitor to finish; as soon as it has started, end your turn by replying exactly ROOT_DONE.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nUse the Monitor tool to watch this command: 'for i in 1 2 3; do sleep 8; echo tick $i; done'. Do not wait for the monitor to finish; as soon as it has started, end your turn by replying exactly ROOT_DONE.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nUse the Monitor tool to watch this command: 'for i in 1 2 3; do sleep 8; echo tick $i; done'. Do not wait for the monitor to finish; as soon as it has started, end your turn by replying exactly ROOT_DONE.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nUse the Monitor tool to watch this command: 'for i in 1 2 3; do sleep 8; echo tick $i; done'. Do not wait for the monitor to finish; as soon as it has started, end your turn by replying exactly ROOT_DONE.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/grok_prompt_error/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/grok_prompt_error/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/grok_prompt_error/grok_transcript.ndjson
@@ -28,4 +28,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":true,"activity":"working","resident":true,"lastChangeUnixMs":1790805582748,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: grok prompt error fixture\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: grok prompt error fixture\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: grok prompt error fixture\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: grok prompt error fixture\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/session_notification:hook_run_started","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"hook_run_started","event_name":"user_prompt_submit","prompt_id":"t3-xai-prompt-1","count":1},"_meta":{"agentTimestampMs":1790805582754}}}}
@@ -43,4 +43,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":true,"activity":"working","resident":true,"lastChangeUnixMs":1790805583632,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-2","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: grok prompt error fixture recovered\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-2","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: grok prompt error fixture recovered\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-2","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: grok prompt error fixture recovered\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-2","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: grok prompt error fixture recovered\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/session_notification:hook_run_started","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"hook_run_started","event_name":"user_prompt_submit","prompt_id":"t3-xai-prompt-2","count":1},"_meta":{"agentTimestampMs":1790805583637}}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/grok_transcript.ndjson
@@ -25,4 +25,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790300235622,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: steering fixture initial response\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: steering fixture initial response\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: steering fixture initial response\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: steering fixture initial response\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"expect_outbound","label":"notification:session/cancel","frame":{"kind":"notification","method":"session/cancel","params":{"sessionId":"00000000-0000-4000-8000-000000000001","_meta":{"cancelTrigger":"ctrl_c"}}}}
@@ -34,4 +34,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790300235729,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-2","version":0,"kind":"prompt","text":"Actually, respond with exactly: steering fixture observed\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-2","runningText":"Actually, respond with exactly: steering fixture observed\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-2","version":0,"kind":"prompt","text":"Actually, respond with exactly: steering fixture observed\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-2","runningText":"Actually, respond with exactly: steering fixture observed\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/pi_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/pi_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/message_steering/pi_transcript.ndjson
@@ -3,3 +3,3 @@
 {"type":"expect_outbound","label":"get_state","frame":{"type":"get_state","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:get_state","frame":{"id":"t3-0","type":"response","command":"get_state","success":true,"data":{"model":{"type":"chat","id":"deepseek/deepseek-v4-flash","name":"DeepSeek: DeepSeek V4 Flash 0423","api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","provider":"openrouter","reasoning":true,"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":"xhigh","max":null},"input":["text"],"cost":{"input":0.04186,"output":0.08372,"cacheRead":0.008372,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"compat":{"supportsDeveloperRole":false,"thinkingFormat":"openrouter","supportsStrictMode":true,"sendSessionAffinityHeaders":true,"requiresReasoningContentOnAssistantMessages":true}},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"/pi-sessions/session-1.jsonl","sessionId":"00000000-0000-4000-8000-000000000002","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/grok_transcript.ndjson
@@ -26,4 +26,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790299188461,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: first fixture turn complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: first fixture turn complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: first fixture turn complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: first fixture turn complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
@@ -59,4 +59,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790299198569,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-2","version":0,"kind":"prompt","text":"Respond with exactly: second fixture turn complete\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-2","runningText":"Respond with exactly: second fixture turn complete\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-2","version":0,"kind":"prompt","text":"Respond with exactly: second fixture turn complete\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-2","runningText":"Respond with exactly: second fixture turn complete\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:session/update:agent_thought_chunk","frame":{"kind":"notification","method":"session/update","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The"}},"_meta":{"totalTokens":22571,"eventId":"00000000-0000-4000-8000-000000000001-31","agentTimestampMs":1790299207228,"promptId":"t3-xai-prompt-2","streamStartMs":1790299199366,"turnStartMs":1790299198616,"updateType":"AgentThoughtChunk","chunkId":1}}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/muse_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/muse_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/muse_transcript.ndjson
@@ -9,3 +9,3 @@
 {"type":"emit_inbound","label":"session/approvalModeChanged","frame":{"jsonrpc":"2.0","method":"session/approvalModeChanged","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:1","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"37b19bd1-b212-4532-a0c9-a6677f303e26","sequence":5},"last":{"id":"37b19bd1-b212-4532-a0c9-a6677f303e26","sequence":5}},"mode":"allowAll","source":"approvalReconfigure","commandId":"01a11a6b-707e-7001-b2f4-23db74e60097","clientName":"t3_code"},"emittedAtMs":1791444611412}}
-{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Respond with exactly: first fixture turn complete"}],"displayText":"Respond with exactly: first fixture turn complete","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4"}}}
+{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Respond with exactly: first fixture turn complete"}],"displayText":"Respond with exactly: first fixture turn complete","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4"}}}
 {"type":"emit_inbound","label":"session/branchChanged","frame":{"jsonrpc":"2.0","method":"session/branchChanged","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:2","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"2c530748-943b-4467-8473-da8b04c511c3","sequence":16},"last":{"id":"2c530748-943b-4467-8473-da8b04c511c3","sequence":16}},"workspaceRoot":"<workspace>","branch":"main","vcs":"git"},"emittedAtMs":1791444611661}}
@@ -14,4 +14,4 @@
 {"type":"emit_inbound","label":"turn/started","frame":{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:3","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"2be0c9b5-9dc4-48f0-9b86-06aef4de31f3","sequence":18},"last":{"id":"2be0c9b5-9dc4-48f0-9b86-06aef4de31f3","sequence":18}},"turnId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4","commandId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4"},"emittedAtMs":1791444611675}}
-{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:4","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"2be0c9b5-9dc4-48f0-9b86-06aef4de31f3","sequence":18},"last":{"id":"2be0c9b5-9dc4-48f0-9b86-06aef4de31f3","sequence":18}},"item":{"itemId":"1b470279-ee8c-4c74-a298-f37184145584","kind":"userMessage","turnId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4","revision":1,"status":"completed","recordedAt":"2026-10-08T07:30:11.66263Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with exactly: first fixture turn complete","commandId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4"}},"emittedAtMs":1791444611675}}
-{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:5","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"31b500d6-40fc-4f4c-b097-6b7be8d77cee","sequence":20},"last":{"id":"31b500d6-40fc-4f4c-b097-6b7be8d77cee","sequence":20}},"item":{"itemId":"1b470279-ee8c-4c74-a298-f37184145584","kind":"userMessage","turnId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4","revision":2,"status":"completed","recordedAt":"2026-10-08T07:30:11.680942Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with exactly: first fixture turn complete","displayText":"Respond with exactly: first fixture turn complete","commandId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4"}},"emittedAtMs":1791444611689}}
+{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:4","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"2be0c9b5-9dc4-48f0-9b86-06aef4de31f3","sequence":18},"last":{"id":"2be0c9b5-9dc4-48f0-9b86-06aef4de31f3","sequence":18}},"item":{"itemId":"1b470279-ee8c-4c74-a298-f37184145584","kind":"userMessage","turnId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4","revision":1,"status":"completed","recordedAt":"2026-10-08T07:30:11.66263Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with exactly: first fixture turn complete","commandId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4"}},"emittedAtMs":1791444611675}}
+{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:5","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"31b500d6-40fc-4f4c-b097-6b7be8d77cee","sequence":20},"last":{"id":"31b500d6-40fc-4f4c-b097-6b7be8d77cee","sequence":20}},"item":{"itemId":"1b470279-ee8c-4c74-a298-f37184145584","kind":"userMessage","turnId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4","revision":2,"status":"completed","recordedAt":"2026-10-08T07:30:11.680942Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with exactly: first fixture turn complete","displayText":"Respond with exactly: first fixture turn complete","commandId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4"}},"emittedAtMs":1791444611689}}
 {"type":"emit_inbound","label":"item/started","frame":{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:6","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"077780ea-0dc9-4d7a-879c-ee368f3adbe0","sequence":37},"last":{"id":"077780ea-0dc9-4d7a-879c-ee368f3adbe0","sequence":37}},"item":{"itemId":"077780ea-0dc9-4d7a-879c-ee368f3adbe0","kind":"reminderChild","turnId":"01a11a6b-722c-7000-a73a-1d49a3a7f4c4","revision":1,"status":"inProgress","recordedAt":"2026-10-08T07:30:11.790301Z","fallbackText":"Reminder child session","childSessionId":"c13379db-6761-40b4-a974-b0f1a58717aa","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a11a6b-72ac-7972-a1df-b343b7804b38"}},"emittedAtMs":1791444611795}}
@@ -31,3 +31,3 @@
 {"type":"emit_inbound","label":"session/branchChanged","frame":{"jsonrpc":"2.0","method":"session/branchChanged","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:17","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"36753b8a-26ce-4935-8127-bc9191cb328b","sequence":80},"last":{"id":"36753b8a-26ce-4935-8127-bc9191cb328b","sequence":80}},"workspaceRoot":"<workspace>","branch":"main","vcs":"git"},"emittedAtMs":1791444621054}}
-{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":4,"method":"turn/start","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Respond with exactly: second fixture turn complete"}],"displayText":"Respond with exactly: second fixture turn complete","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6b-97ec-7000-bd1b-d7afbea11045"}}}
+{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":4,"method":"turn/start","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Respond with exactly: second fixture turn complete"}],"displayText":"Respond with exactly: second fixture turn complete","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6b-97ec-7000-bd1b-d7afbea11045"}}}
 {"type":"emit_inbound","label":"response:turn/start","frame":{"jsonrpc":"2.0","id":4,"result":{"commandId":"01a11a6b-97ec-7000-bd1b-d7afbea11045","status":"accepted","turnId":"01a11a6b-97ec-7000-bd1b-d7afbea11045","startedNewTurn":true,"disposition":"started"}}}
@@ -35,4 +35,4 @@
 {"type":"emit_inbound","label":"turn/started","frame":{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:18","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"4aba96d5-f984-4bc0-bda4-7fb97f527686","sequence":87},"last":{"id":"4aba96d5-f984-4bc0-bda4-7fb97f527686","sequence":87}},"turnId":"01a11a6b-97ec-7000-bd1b-d7afbea11045","commandId":"01a11a6b-97ec-7000-bd1b-d7afbea11045"},"emittedAtMs":1791444621334}}
-{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:19","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"4aba96d5-f984-4bc0-bda4-7fb97f527686","sequence":87},"last":{"id":"4aba96d5-f984-4bc0-bda4-7fb97f527686","sequence":87}},"item":{"itemId":"90719a5d-d2c1-46dc-ad4d-274adda02344","kind":"userMessage","turnId":"01a11a6b-97ec-7000-bd1b-d7afbea11045","revision":1,"status":"completed","recordedAt":"2026-10-08T07:30:21.321391Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with exactly: second fixture turn complete","commandId":"01a11a6b-97ec-7000-bd1b-d7afbea11045"}},"emittedAtMs":1791444621334}}
-{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:20","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"dc502e2c-d81c-4f0e-ad86-dd11d1368677","sequence":89},"last":{"id":"dc502e2c-d81c-4f0e-ad86-dd11d1368677","sequence":89}},"item":{"itemId":"90719a5d-d2c1-46dc-ad4d-274adda02344","kind":"userMessage","turnId":"01a11a6b-97ec-7000-bd1b-d7afbea11045","revision":2,"status":"completed","recordedAt":"2026-10-08T07:30:21.338944Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with exactly: second fixture turn complete","displayText":"Respond with exactly: second fixture turn complete","commandId":"01a11a6b-97ec-7000-bd1b-d7afbea11045"}},"emittedAtMs":1791444621347}}
+{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:19","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"4aba96d5-f984-4bc0-bda4-7fb97f527686","sequence":87},"last":{"id":"4aba96d5-f984-4bc0-bda4-7fb97f527686","sequence":87}},"item":{"itemId":"90719a5d-d2c1-46dc-ad4d-274adda02344","kind":"userMessage","turnId":"01a11a6b-97ec-7000-bd1b-d7afbea11045","revision":1,"status":"completed","recordedAt":"2026-10-08T07:30:21.321391Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with exactly: second fixture turn complete","commandId":"01a11a6b-97ec-7000-bd1b-d7afbea11045"}},"emittedAtMs":1791444621334}}
+{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:20","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"dc502e2c-d81c-4f0e-ad86-dd11d1368677","sequence":89},"last":{"id":"dc502e2c-d81c-4f0e-ad86-dd11d1368677","sequence":89}},"item":{"itemId":"90719a5d-d2c1-46dc-ad4d-274adda02344","kind":"userMessage","turnId":"01a11a6b-97ec-7000-bd1b-d7afbea11045","revision":2,"status":"completed","recordedAt":"2026-10-08T07:30:21.338944Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with exactly: second fixture turn complete","displayText":"Respond with exactly: second fixture turn complete","commandId":"01a11a6b-97ec-7000-bd1b-d7afbea11045"}},"emittedAtMs":1791444621347}}
 {"type":"emit_inbound","label":"item/started","frame":{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a11a6b-707e-7000-9bb5-4079c7772ad0","viewCursor":"v:01a11a6b-707e-7000-9bb5-4079c7772ad0:21","sourceRange":{"stream":{"kind":"session","id":"01a11a6b-707e-7000-9bb5-4079c7772ad0"},"first":{"id":"09cb4c2a-03c2-4089-ba12-8d5d31f7ea48","sequence":106},"last":{"id":"09cb4c2a-03c2-4089-ba12-8d5d31f7ea48","sequence":106}},"item":{"itemId":"09cb4c2a-03c2-4089-ba12-8d5d31f7ea48","kind":"reminderChild","turnId":"01a11a6b-97ec-7000-bd1b-d7afbea11045","revision":1,"status":"inProgress","recordedAt":"2026-10-08T07:30:21.446966Z","fallbackText":"Reminder child session","childSessionId":"cd97261a-3ea9-480f-9e54-5e59bb077da2","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a11a6b-9869-7061-a4f3-42daa3e3a8f1"}},"emittedAtMs":1791444621455}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/pi_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/pi_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/pi_transcript.ndjson
@@ -3,3 +3,3 @@
 {"type":"expect_outbound","label":"get_state","frame":{"type":"get_state","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:get_state","frame":{"id":"t3-0","type":"response","command":"get_state","success":true,"data":{"model":{"type":"chat","id":"deepseek/deepseek-v4-flash","name":"DeepSeek: DeepSeek V4 Flash 0423","api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","provider":"openrouter","reasoning":true,"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":"xhigh","max":null},"input":["text"],"cost":{"input":0.04186,"output":0.08372,"cacheRead":0.008372,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"compat":{"supportsDeveloperRole":false,"thinkingFormat":"openrouter","supportsStrictMode":true,"sendSessionAffinityHeaders":true,"requiresReasoningContentOnAssistantMessages":true}},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"/pi-sessions/session-1.jsonl","sessionId":"00000000-0000-4000-8000-000000000002","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/muse_permission/muse_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/muse_permission/muse_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/muse_permission/muse_transcript.ndjson
@@ -9,3 +9,3 @@
 {"type":"emit_inbound","label":"session/approvalModeChanged","frame":{"jsonrpc":"2.0","method":"session/approvalModeChanged","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:1","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"b05fb8ec-7b58-4cf7-a369-379938395230","sequence":5},"last":{"id":"b05fb8ec-7b58-4cf7-a369-379938395230","sequence":5}},"mode":"promptUnmatched","source":"approvalReconfigure","commandId":"01a11a6d-39bb-7001-923e-425cc6129ce7","clientName":"t3_code"},"emittedAtMs":1791444728501}}
-{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE."}],"displayText":"Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE.","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6"}}}
+{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE."}],"displayText":"Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE.","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6"}}}
 {"type":"emit_inbound","label":"session/branchChanged","frame":{"jsonrpc":"2.0","method":"session/branchChanged","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:2","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"6159e84a-ae1e-4fae-ae8b-49f41ca34509","sequence":16},"last":{"id":"6159e84a-ae1e-4fae-ae8b-49f41ca34509","sequence":16}},"workspaceRoot":"<workspace>","branch":"main","vcs":"git"},"emittedAtMs":1791444728769}}
@@ -14,4 +14,4 @@
 {"type":"emit_inbound","label":"turn/started","frame":{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:3","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"09218c3a-88fd-4bc8-ab45-d1aa69bea95a","sequence":18},"last":{"id":"09218c3a-88fd-4bc8-ab45-d1aa69bea95a","sequence":18}},"turnId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6","commandId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6"},"emittedAtMs":1791444728783}}
-{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:4","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"09218c3a-88fd-4bc8-ab45-d1aa69bea95a","sequence":18},"last":{"id":"09218c3a-88fd-4bc8-ab45-d1aa69bea95a","sequence":18}},"item":{"itemId":"dde9573b-650f-434b-ab99-60cfc820a0a5","kind":"userMessage","turnId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6","revision":1,"status":"completed","recordedAt":"2026-10-08T07:32:08.769894Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE.","commandId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6"}},"emittedAtMs":1791444728784}}
-{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:5","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"76c57706-1378-4167-8bbf-f76d959804e8","sequence":20},"last":{"id":"76c57706-1378-4167-8bbf-f76d959804e8","sequence":20}},"item":{"itemId":"dde9573b-650f-434b-ab99-60cfc820a0a5","kind":"userMessage","turnId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6","revision":2,"status":"completed","recordedAt":"2026-10-08T07:32:08.791728Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE.","displayText":"Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE.","commandId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6"}},"emittedAtMs":1791444728800}}
+{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:4","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"09218c3a-88fd-4bc8-ab45-d1aa69bea95a","sequence":18},"last":{"id":"09218c3a-88fd-4bc8-ab45-d1aa69bea95a","sequence":18}},"item":{"itemId":"dde9573b-650f-434b-ab99-60cfc820a0a5","kind":"userMessage","turnId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6","revision":1,"status":"completed","recordedAt":"2026-10-08T07:32:08.769894Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE.","commandId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6"}},"emittedAtMs":1791444728784}}
+{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:5","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"76c57706-1378-4167-8bbf-f76d959804e8","sequence":20},"last":{"id":"76c57706-1378-4167-8bbf-f76d959804e8","sequence":20}},"item":{"itemId":"dde9573b-650f-434b-ab99-60cfc820a0a5","kind":"userMessage","turnId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6","revision":2,"status":"completed","recordedAt":"2026-10-08T07:32:08.791728Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE.","displayText":"Run the shell command `touch muse-approved.txt` with your shell tool, then reply DONE.","commandId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6"}},"emittedAtMs":1791444728800}}
 {"type":"emit_inbound","label":"item/started","frame":{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:6","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"29180105-84c4-4f9e-8bfd-003392b93b73","sequence":38},"last":{"id":"29180105-84c4-4f9e-8bfd-003392b93b73","sequence":38}},"item":{"itemId":"29180105-84c4-4f9e-8bfd-003392b93b73","kind":"reminderChild","turnId":"01a11a6d-3b9f-7000-b6ad-ab05e6b973b6","revision":1,"status":"inProgress","recordedAt":"2026-10-08T07:32:08.905989Z","fallbackText":"Reminder child session","childSessionId":"7c9485f9-26aa-4b56-8ca2-f36cb9cfb8c4","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a11a6d-3c27-73f2-8c27-cd06a3b7dadf"}},"emittedAtMs":1791444728910}}
@@ -44,3 +44,3 @@
 {"type":"emit_inbound","label":"session/branchChanged","frame":{"jsonrpc":"2.0","method":"session/branchChanged","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:24","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"1e4afe30-d924-444c-8665-5e763f524e70","sequence":121},"last":{"id":"1e4afe30-d924-444c-8665-5e763f524e70","sequence":121}},"workspaceRoot":"<workspace>","branch":"main","vcs":"git"},"emittedAtMs":1791444747394}}
-{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":5,"method":"turn/start","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED."}],"displayText":"Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED.","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6d-8566-7000-8ad1-6269ac187a29"}}}
+{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":5,"method":"turn/start","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED."}],"displayText":"Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED.","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6d-8566-7000-8ad1-6269ac187a29"}}}
 {"type":"emit_inbound","label":"response:turn/start","frame":{"jsonrpc":"2.0","id":5,"result":{"commandId":"01a11a6d-8566-7000-8ad1-6269ac187a29","status":"accepted","turnId":"01a11a6d-8566-7000-8ad1-6269ac187a29","startedNewTurn":true,"disposition":"started"}}}
@@ -48,4 +48,4 @@
 {"type":"emit_inbound","label":"turn/started","frame":{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:25","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"4a1cf90d-7457-448d-a2b5-d82108636b3b","sequence":128},"last":{"id":"4a1cf90d-7457-448d-a2b5-d82108636b3b","sequence":128}},"turnId":"01a11a6d-8566-7000-8ad1-6269ac187a29","commandId":"01a11a6d-8566-7000-8ad1-6269ac187a29"},"emittedAtMs":1791444747660}}
-{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:26","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"4a1cf90d-7457-448d-a2b5-d82108636b3b","sequence":128},"last":{"id":"4a1cf90d-7457-448d-a2b5-d82108636b3b","sequence":128}},"item":{"itemId":"27473708-71e0-4d3c-811c-a8bae6bbaa3b","kind":"userMessage","turnId":"01a11a6d-8566-7000-8ad1-6269ac187a29","revision":1,"status":"completed","recordedAt":"2026-10-08T07:32:27.650913Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED.","commandId":"01a11a6d-8566-7000-8ad1-6269ac187a29"}},"emittedAtMs":1791444747660}}
-{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:27","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"4a056a03-469a-4c9f-94a9-78eb815023ad","sequence":130},"last":{"id":"4a056a03-469a-4c9f-94a9-78eb815023ad","sequence":130}},"item":{"itemId":"27473708-71e0-4d3c-811c-a8bae6bbaa3b","kind":"userMessage","turnId":"01a11a6d-8566-7000-8ad1-6269ac187a29","revision":2,"status":"completed","recordedAt":"2026-10-08T07:32:27.66745Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED.","displayText":"Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED.","commandId":"01a11a6d-8566-7000-8ad1-6269ac187a29"}},"emittedAtMs":1791444747676}}
+{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:26","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"4a1cf90d-7457-448d-a2b5-d82108636b3b","sequence":128},"last":{"id":"4a1cf90d-7457-448d-a2b5-d82108636b3b","sequence":128}},"item":{"itemId":"27473708-71e0-4d3c-811c-a8bae6bbaa3b","kind":"userMessage","turnId":"01a11a6d-8566-7000-8ad1-6269ac187a29","revision":1,"status":"completed","recordedAt":"2026-10-08T07:32:27.650913Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED.","commandId":"01a11a6d-8566-7000-8ad1-6269ac187a29"}},"emittedAtMs":1791444747660}}
+{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:27","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"4a056a03-469a-4c9f-94a9-78eb815023ad","sequence":130},"last":{"id":"4a056a03-469a-4c9f-94a9-78eb815023ad","sequence":130}},"item":{"itemId":"27473708-71e0-4d3c-811c-a8bae6bbaa3b","kind":"userMessage","turnId":"01a11a6d-8566-7000-8ad1-6269ac187a29","revision":2,"status":"completed","recordedAt":"2026-10-08T07:32:27.66745Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED.","displayText":"Run the shell command `touch muse-declined.txt` with your shell tool once. If it is rejected, do not retry; reply REJECTED.","commandId":"01a11a6d-8566-7000-8ad1-6269ac187a29"}},"emittedAtMs":1791444747676}}
 {"type":"emit_inbound","label":"item/started","frame":{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a11a6d-39bb-7000-8c93-4594c98e6a11","viewCursor":"v:01a11a6d-39bb-7000-8c93-4594c98e6a11:28","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-39bb-7000-8c93-4594c98e6a11"},"first":{"id":"3b28955d-a87a-4acb-97e9-14cad87fd41f","sequence":148},"last":{"id":"3b28955d-a87a-4acb-97e9-14cad87fd41f","sequence":148}},"item":{"itemId":"3b28955d-a87a-4acb-97e9-14cad87fd41f","kind":"reminderChild","turnId":"01a11a6d-8566-7000-8ad1-6269ac187a29","revision":1,"status":"inProgress","recordedAt":"2026-10-08T07:32:27.787099Z","fallbackText":"Reminder child session","childSessionId":"efd21bf1-4fd1-49a2-9c55-91b7fc099765","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a11a6d-85ed-7b91-8d91-c4ce76b6dfef"}},"emittedAtMs":1791444747794}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/muse_workflow/muse_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/muse_workflow/muse_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/muse_workflow/muse_transcript.ndjson
@@ -9,3 +9,3 @@
 {"type":"emit_inbound","label":"session/approvalModeChanged","frame":{"jsonrpc":"2.0","method":"session/approvalModeChanged","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","viewCursor":"v:01a11aab-8cb6-7000-9205-29210d8cba14:1","sourceRange":{"stream":{"kind":"session","id":"01a11aab-8cb6-7000-9205-29210d8cba14"},"first":{"id":"a765a019-4134-4dcc-9670-bb417f56dd73","sequence":5},"last":{"id":"a765a019-4134-4dcc-9670-bb417f56dd73","sequence":5}},"mode":"allowAll","source":"approvalReconfigure","commandId":"01a11aab-8cb6-7001-b163-263bd1ffce65","clientName":"t3_code"},"emittedAtMs":1791448812999}}
-{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it."}],"displayText":"Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11aab-8ee7-7000-b203-c4307a1525c0"}}}
+{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it."}],"displayText":"Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11aab-8ee7-7000-b203-c4307a1525c0"}}}
 {"type":"emit_inbound","label":"session/branchChanged","frame":{"jsonrpc":"2.0","method":"session/branchChanged","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","viewCursor":"v:01a11aab-8cb6-7000-9205-29210d8cba14:2","sourceRange":{"stream":{"kind":"session","id":"01a11aab-8cb6-7000-9205-29210d8cba14"},"first":{"id":"6ff72c4f-0c16-4715-ac9e-6f97c409eabd","sequence":16},"last":{"id":"6ff72c4f-0c16-4715-ac9e-6f97c409eabd","sequence":16}},"workspaceRoot":"<workspace>","branch":"main","vcs":"git"},"emittedAtMs":1791448813318}}
@@ -14,4 +14,4 @@
 {"type":"emit_inbound","label":"turn/started","frame":{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","viewCursor":"v:01a11aab-8cb6-7000-9205-29210d8cba14:3","sourceRange":{"stream":{"kind":"session","id":"01a11aab-8cb6-7000-9205-29210d8cba14"},"first":{"id":"eb897568-08d7-4349-b89d-640263d9967f","sequence":18},"last":{"id":"eb897568-08d7-4349-b89d-640263d9967f","sequence":18}},"turnId":"01a11aab-8ee7-7000-b203-c4307a1525c0","commandId":"01a11aab-8ee7-7000-b203-c4307a1525c0"},"emittedAtMs":1791448813332}}
-{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","viewCursor":"v:01a11aab-8cb6-7000-9205-29210d8cba14:4","sourceRange":{"stream":{"kind":"session","id":"01a11aab-8cb6-7000-9205-29210d8cba14"},"first":{"id":"eb897568-08d7-4349-b89d-640263d9967f","sequence":18},"last":{"id":"eb897568-08d7-4349-b89d-640263d9967f","sequence":18}},"item":{"itemId":"07018014-fee3-4734-9a92-51d894dc405b","kind":"userMessage","turnId":"01a11aab-8ee7-7000-b203-c4307a1525c0","revision":1,"status":"completed","recordedAt":"2026-10-08T08:40:13.319673Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.","commandId":"01a11aab-8ee7-7000-b203-c4307a1525c0"}},"emittedAtMs":1791448813332}}
-{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","viewCursor":"v:01a11aab-8cb6-7000-9205-29210d8cba14:5","sourceRange":{"stream":{"kind":"session","id":"01a11aab-8cb6-7000-9205-29210d8cba14"},"first":{"id":"ffd04d53-2202-490a-8bbf-d70ea59fd489","sequence":20},"last":{"id":"ffd04d53-2202-490a-8bbf-d70ea59fd489","sequence":20}},"item":{"itemId":"07018014-fee3-4734-9a92-51d894dc405b","kind":"userMessage","turnId":"01a11aab-8ee7-7000-b203-c4307a1525c0","revision":2,"status":"completed","recordedAt":"2026-10-08T08:40:13.338821Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.","displayText":"Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.","commandId":"01a11aab-8ee7-7000-b203-c4307a1525c0"}},"emittedAtMs":1791448813343}}
+{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","viewCursor":"v:01a11aab-8cb6-7000-9205-29210d8cba14:4","sourceRange":{"stream":{"kind":"session","id":"01a11aab-8cb6-7000-9205-29210d8cba14"},"first":{"id":"eb897568-08d7-4349-b89d-640263d9967f","sequence":18},"last":{"id":"eb897568-08d7-4349-b89d-640263d9967f","sequence":18}},"item":{"itemId":"07018014-fee3-4734-9a92-51d894dc405b","kind":"userMessage","turnId":"01a11aab-8ee7-7000-b203-c4307a1525c0","revision":1,"status":"completed","recordedAt":"2026-10-08T08:40:13.319673Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.","commandId":"01a11aab-8ee7-7000-b203-c4307a1525c0"}},"emittedAtMs":1791448813332}}
+{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","viewCursor":"v:01a11aab-8cb6-7000-9205-29210d8cba14:5","sourceRange":{"stream":{"kind":"session","id":"01a11aab-8cb6-7000-9205-29210d8cba14"},"first":{"id":"ffd04d53-2202-490a-8bbf-d70ea59fd489","sequence":20},"last":{"id":"ffd04d53-2202-490a-8bbf-d70ea59fd489","sequence":20}},"item":{"itemId":"07018014-fee3-4734-9a92-51d894dc405b","kind":"userMessage","turnId":"01a11aab-8ee7-7000-b203-c4307a1525c0","revision":2,"status":"completed","recordedAt":"2026-10-08T08:40:13.338821Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.","displayText":"Use your workflow tool to launch a workflow with exactly TWO agents: one labeled 'ping' that replies with the word PING, and one labeled 'pong' that replies with the word PONG. Launch it and end your turn; do not wait for it.","commandId":"01a11aab-8ee7-7000-b203-c4307a1525c0"}},"emittedAtMs":1791448813343}}
 {"type":"emit_inbound","label":"item/started","frame":{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a11aab-8cb6-7000-9205-29210d8cba14","viewCursor":"v:01a11aab-8cb6-7000-9205-29210d8cba14:6","sourceRange":{"stream":{"kind":"session","id":"01a11aab-8cb6-7000-9205-29210d8cba14"},"first":{"id":"72918649-2037-422e-b164-46bb35afb7e4","sequence":37},"last":{"id":"72918649-2037-422e-b164-46bb35afb7e4","sequence":37}},"item":{"itemId":"72918649-2037-422e-b164-46bb35afb7e4","kind":"reminderChild","turnId":"01a11aab-8ee7-7000-b203-c4307a1525c0","revision":1,"status":"inProgress","recordedAt":"2026-10-08T08:40:13.451887Z","fallbackText":"Reminder child session","childSessionId":"09fe2f90-21e4-4890-820b-675c3f4d539c","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a11aab-8f66-7913-b12b-a5e59f80375f"}},"emittedAtMs":1791448813456}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_background/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_background/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_background/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7a3271001Z06XG1eDh56UaK", "created": 1790657049201, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f1485cda4ffeXuc6GjAU9vDiRb", "slug": "cosmic-harbor", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike background", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f1485cda4ffeXuc6GjAU9vDiRb", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1485cda4ffeXuc6GjAU9vDiRb", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1485cda4ffeXuc6GjAU9vDiRb", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_command/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_command/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_command/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0f0d833cf001vCmbwtG6y6Wg1U", "created": 1790747096015, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f0f27cc49ffe6wl0jdiu4kO4FC", "slug": "shiny-squid", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "oc2-8 command_t3", "permissions": [{"action": "*", "resource": "*", "effect": "allow"}], "model": {"id": "deepseek/deepseek-v4-flash", "providerID": "openrouter"}}, "durable": {"aggregateID": "ses_f0f27cc49ffe6wl0jdiu4kO4FC", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f0f27cc49ffe6wl0jdiu4kO4FC", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f0f27cc49ffe6wl0jdiu4kO4FC", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_compaction/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_compaction/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_compaction/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7b6d2c0017hjEa3lkp3ZkkO", "created": 1790657129772, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f148492e3ffeQ91rU0GmbvwzYL", "slug": "neon-wizard", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike compaction", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f148492e3ffeQ91rU0GmbvwzYL", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f148492e3ffeQ91rU0GmbvwzYL", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f148492e3ffeQ91rU0GmbvwzYL", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_fork/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_fork/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_fork/opencode_transcript.ndjson
@@ -6,7 +6,7 @@
 {"type": "expect_outbound", "label": "session.create", "frame": {"type": "session.create", "input": "<any>"}}
 {"type": "emit_inbound", "label": "session.create.response", "frame": {"type": "sdk.response", "operation": "session.create", "data": {"data": {"id": "ses_f1484ea8affe5aTo8CcgbGIszj", "projectID": "global", "model": {"id": "big-pickle", "providerID": "opencode", "variant": "default"}, "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1790657107336, "updated": 1790657107336}, "title": "spike fork", "location": {"directory": "<work>"}}}}}
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7b1588001REWGPFiBf7rtLq", "created": 1790657107336, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f1484ea8affe5aTo8CcgbGIszj", "slug": "playful-garden", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike fork", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f1484ea8affe5aTo8CcgbGIszj", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1484ea8affe5aTo8CcgbGIszj", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1484ea8affe5aTo8CcgbGIszj", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
 {"type": "expect_outbound", "label": "session.prompt", "frame": {"type": "session.prompt", "input": {"sessionID": "ses_f1484ea8affe5aTo8CcgbGIszj", "id": "msg_0eb7b1597001e14VBV3nmQYdFS", "text": "<any>"}}}
 {"type": "emit_inbound", "label": "session.prompt.response", "frame": {"type": "sdk.response", "operation": "session.prompt", "data": {"data": {"id": "msg_0eb7b1597001e14VBV3nmQYdFS", "sessionID": "ses_f1484ea8affe5aTo8CcgbGIszj", "time": {"created": 1790657107353}, "type": "user", "payload": {"text": "Reply exactly ONE."}, "delivery": "steer"}}}}
@@ -47,12 +47,12 @@
 {"type": "emit_inbound", "label": "message.list.response.2", "frame": {"type": "sdk.response", "operation": "message.list", "data": {"data": [], "cursor": {}}}}
 {"type": "expect_outbound", "label": "session.fork", "frame": {"type": "session.fork", "input": {"sessionID": "ses_f1484ea8affe5aTo8CcgbGIszj", "before": "msg_0eb7b1f9f001g95Bduh3bi8syS"}}}
 {"type": "emit_inbound", "label": "session.fork.response", "frame": {"type": "sdk.response", "operation": "session.fork", "data": {"data": {"id": "ses_f1484db83ffeLGtrRCFimo1H0e", "fork": {"sessionID": "ses_f1484ea8affe5aTo8CcgbGIszj", "boundary": {"type": "before", "messageID": "msg_0eb7b1f9f001g95Bduh3bi8syS"}}, "projectID": "global", "model": {"id": "big-pickle", "providerID": "opencode", "variant": "default"}, "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1790657111165, "updated": 1790657111165}, "title": "spike fork (fork #1)", "location": {"directory": "<work>"}, "permissions": [{"action": "*", "resource": "*", "effect": "allow"}, {"action": "subagent", "resource": "*", "effect": "deny"}]}}}}
-{"type": "expect_outbound", "label": "session.update", "frame": {"type": "session.update", "input": {"sessionID": "ses_f1484db83ffeLGtrRCFimo1H0e", "permissions": [{"action": "*", "resource": "*", "effect": "allow"}, {"action": "t3-code-*", "resource": "*", "effect": "deny"}, {"action": "t3-code-thread_opencode2-fork_target_*", "resource": "*", "effect": "allow"}]}}}
+{"type": "expect_outbound", "label": "session.update", "frame": {"type": "session.update", "input": {"sessionID": "ses_f1484db83ffeLGtrRCFimo1H0e", "permissions": [{"action": "*", "resource": "*", "effect": "allow"}, {"action": "t3-code-*", "resource": "*", "effect": "deny"}, {"action": "goat-*", "resource": "*", "effect": "deny"}, {"action": "goat-f74b9d2803b51629_*", "resource": "*", "effect": "allow"}]}}}
 {"type": "emit_inbound", "label": "session.update.response", "frame": {"type": "sdk.response", "operation": "session.update", "data": null}}
 {"type": "emit_inbound", "label": "session.forked", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7b247d001fXzFroPg5P0bps", "created": 1790657111165, "type": "session.forked", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f1484db83ffeLGtrRCFimo1H0e", "parentID": "ses_f1484ea8affe5aTo8CcgbGIszj", "boundary": {"type": "before", "messageID": "msg_0eb7b1f9f001g95Bduh3bi8syS"}, "instructions": {"core/environment": "db4a793a05fec32fdfa985a3432125a86d6cb42debc8b9ee8f6a99fbfcf2f93b", "core/date": "bf08b8486572ab3eef677a3c9ee12468e411ae41a8f4d2fb6cf02a6ca73f1986", "core/codemode": "616a7ad8b8e40e8a71eab238dfbbe9eaf0f4a9e6fdad853226d075bfe602e1e6", "core/skill-guidance": "0d001919496102654717308c72635523bf7c3cd99c81e058cc79f2947104f9a5"}, "instructionEntries": []}, "durable": {"aggregateID": "ses_f1484db83ffeLGtrRCFimo1H0e", "seq": 0, "version": 2}}}}
 {"type": "expect_outbound", "label": "session.update.title", "frame": {"type": "session.update", "input": {"sessionID": "ses_f1484db83ffeLGtrRCFimo1H0e", "title": "<any>"}}}
 {"type": "emit_inbound", "label": "session.update.title.response", "frame": {"type": "sdk.response", "operation": "session.update", "data": null}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put.2", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1484db83ffeLGtrRCFimo1H0e", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put.2", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1484db83ffeLGtrRCFimo1H0e", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response.2", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
 {"type": "expect_outbound", "label": "session.prompt.3", "frame": {"type": "session.prompt", "input": {"sessionID": "ses_f1484db83ffeLGtrRCFimo1H0e", "id": "msg_0eb7b2493001nZTYCniIjU5Y65", "text": "<any>"}}}
 {"type": "emit_inbound", "label": "session.prompt.response.3", "frame": {"type": "sdk.response", "operation": "session.prompt", "data": {"data": {"id": "msg_0eb7b2493001nZTYCniIjU5Y65", "sessionID": "ses_f1484db83ffeLGtrRCFimo1H0e", "time": {"created": 1790657111188}, "type": "user", "payload": {"text": "What did you reply last time? Answer in one word."}, "delivery": "steer"}}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_inbox/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_inbox/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_inbox/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7ab3a0001MfhwH3aV04StYO", "created": 1790657082272, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f14854c71ffeuPLxKSK70AHWvd", "slug": "lucky-mountain", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike inbox", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f14854c71ffeuPLxKSK70AHWvd", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14854c71ffeuPLxKSK70AHWvd", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14854c71ffeuPLxKSK70AHWvd", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_interrupt/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_interrupt/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_interrupt/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb737dcf001Bcj0k2QTAM0Kvj", "created": 1790656609743, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f148c8240ffegmJ5ZhqhyYOcSH", "slug": "gentle-cabin", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike interrupt", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f148c8240ffegmJ5ZhqhyYOcSH", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f148c8240ffegmJ5ZhqhyYOcSH", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f148c8240ffegmJ5ZhqhyYOcSH", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_nested_background/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_nested_background/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_nested_background/opencode_transcript.ndjson
@@ -7,3 +7,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0f73f77e4001G992P0v23j0KVF", "created": 1790854526948, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f08c08821ffefFAD3sMjkyP0Fd", "slug": "quiet-canyon", "version": "2.0.18", "projectID": "3b9597874c088ee0849b0d68c211296e47876139", "location": {"directory": "<work>"}, "subpath": "", "title": "nested nested", "permissions": [{"action": "*", "resource": "*", "effect": "allow"}], "model": {"id": "deepseek/deepseek-v4-flash", "providerID": "openrouter"}}, "durable": {"aggregateID": "ses_f08c08821ffefFAD3sMjkyP0Fd", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f08c08821ffefFAD3sMjkyP0Fd", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f08c08821ffefFAD3sMjkyP0Fd", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_permission/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_permission/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_permission/opencode_transcript.ndjson
@@ -10,3 +10,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7c43090019BtXQ5r0ZjDWSV", "created": 1790657184522, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f1483bd0affez3sG5IbKgOai7e", "slug": "misty-orchid", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike permission", "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}], "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f1483bd0affez3sG5IbKgOai7e", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1483bd0affez3sG5IbKgOai7e", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1483bd0affez3sG5IbKgOai7e", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_question/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_question/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_question/opencode_transcript.ndjson
@@ -9,3 +9,3 @@
 {"type": "emit_inbound", "label": "project.updated", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb79a223001QhSQm49nHEj9HB", "created": 1790657012259, "type": "project.updated", "data": {"id": "global", "canonical": "<work>", "vcs": "git", "time": {"created": 1790656063718, "updated": 1790656063718, "active": 1790657012258}, "sandboxes": []}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14865e15ffewHnFwxdBlN6Eqc", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14865e15ffewHnFwxdBlN6Eqc", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_resume_after_restart/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_resume_after_restart/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_resume_after_restart/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb809bdd001yy0JandzMmaPi5", "created": 1790657469405, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f147f6435ffeBiqeQBvUukyPaj", "slug": "happy-tiger", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike restart_a", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f147f6435ffeBiqeQBvUukyPaj", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f147f6435ffeBiqeQBvUukyPaj", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f147f6435ffeBiqeQBvUukyPaj", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_revert/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_revert/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_revert/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7b411d0014yaniNS8WiN6zE", "created": 1790657118493, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f1484bef1ffeGfSJ1e2FXLCaus", "slug": "witty-canyon", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike revert", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f1484bef1ffeGfSJ1e2FXLCaus", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1484bef1ffeGfSJ1e2FXLCaus", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f1484bef1ffeGfSJ1e2FXLCaus", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_simple/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_simple/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_simple/opencode_transcript.ndjson
@@ -9,3 +9,3 @@
 {"type": "emit_inbound", "label": "project.updated", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb732078001oO5ghtqXkMav9d", "created": 1790656585848, "type": "project.updated", "data": {"id": "global", "canonical": "<work>", "vcs": "git", "time": {"created": 1790656063718, "updated": 1790656063718, "active": 1790656585847}, "sandboxes": []}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f148cdfa1ffeIFwbC0FCx0fKpk", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f148cdfa1ffeIFwbC0FCx0fKpk", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_skill/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_skill/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_skill/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0f0d84083001QSHajGz7TcpzgV", "created": 1790747099267, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f0f27bf90ffeEzhR6OIvZo6Y1l", "slug": "happy-rocket", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "oc2-8 skill_t3", "permissions": [{"action": "*", "resource": "*", "effect": "allow"}], "model": {"id": "deepseek/deepseek-v4-flash", "providerID": "openrouter"}}, "durable": {"aggregateID": "ses_f0f27bf90ffeEzhR6OIvZo6Y1l", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f0f27bf90ffeEzhR6OIvZo6Y1l", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f0f27bf90ffeEzhR6OIvZo6Y1l", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_subagent/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_subagent/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_subagent/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb79d67f001cKJ38bhZTN6LOd", "created": 1790657025663, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f14862990ffe1Cj3Y1mn0nJq0R", "slug": "tidy-wizard", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike subagent", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f14862990ffe1Cj3Y1mn0nJq0R", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14862990ffe1Cj3Y1mn0nJq0R", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14862990ffe1Cj3Y1mn0nJq0R", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_switch/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_switch/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_switch/opencode_transcript.ndjson
@@ -12,7 +12,7 @@
 {"type": "expect_outbound", "label": "session.switchAgent", "frame": {"type": "session.switchAgent", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "agent": "plan"}}}
 {"type": "emit_inbound", "label": "session.switchAgent.response", "frame": {"type": "sdk.response", "operation": "session.switchAgent", "data": null}}
 {"type": "emit_inbound", "label": "session.agent.selected", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7edeb2001MCL22KdHxuErJq", "created": 1790657355442, "type": "session.agent.selected", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "agent": "plan"}, "durable": {"aggregateID": "ses_f14812197ffeCbw641wM2r3ZmP", "seq": 1, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
 {"type": "expect_outbound", "label": "session.prompt", "frame": {"type": "session.prompt", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "text": "<any>"}}}
 {"type": "emit_inbound", "label": "session.prompt.response", "frame": {"type": "sdk.response", "operation": "session.prompt", "data": {"data": {"id": "msg_0eb7edec5001SuzE8LdQ6S95VC", "sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "time": {"created": 1790657355463}, "type": "user", "payload": {"text": "Create a file named plan_probe.txt containing HI using the write tool."}, "delivery": "steer"}}}}
@@ -53,7 +53,7 @@
 {"type": "emit_inbound", "label": "session.execution.succeeded", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7eef75001z9Sy13uGDVqV3F", "created": 1790657359733, "type": "session.execution.succeeded", "data": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP"}, "durable": {"aggregateID": "ses_f14812197ffeCbw641wM2r3ZmP", "seq": 15, "version": 1}}}}
 {"type": "expect_outbound", "label": "session.get", "frame": {"type": "session.get", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP"}}}
 {"type": "emit_inbound", "label": "session.get.response", "frame": {"type": "sdk.response", "operation": "session.get", "data": {"data": {"id": "ses_f14812197ffeCbw641wM2r3ZmP", "projectID": "global", "agent": "plan", "model": {"id": "big-pickle", "providerID": "opencode", "variant": "default"}, "cost": 0, "tokens": {"input": 8910, "output": 271, "reasoning": 0, "cache": {"read": 384, "write": 0}}, "outcome": "succeeded", "time": {"created": 1790657355410, "updated": 1790657355463}, "title": "spike switch", "location": {"directory": "<work>"}, "permissions": [{"action": "*", "resource": "*", "effect": "allow"}, {"action": "subagent", "resource": "*", "effect": "deny"}]}}}}
-{"type": "expect_outbound", "label": "session.update", "frame": {"type": "session.update", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "permissions": [{"action": "*", "resource": "*", "effect": "allow"}, {"action": "t3-code-*", "resource": "*", "effect": "deny"}, {"action": "t3-code-thread_opencode2_switch_*", "resource": "*", "effect": "allow"}]}}}
+{"type": "expect_outbound", "label": "session.update", "frame": {"type": "session.update", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "permissions": [{"action": "*", "resource": "*", "effect": "allow"}, {"action": "t3-code-*", "resource": "*", "effect": "deny"}, {"action": "goat-*", "resource": "*", "effect": "deny"}, {"action": "goat-421cb593d6fcf559_*", "resource": "*", "effect": "allow"}]}}}
 {"type": "emit_inbound", "label": "session.update.response", "frame": {"type": "sdk.response", "operation": "session.update", "data": null}}
 {"type": "expect_outbound", "label": "session.switchAgent.2", "frame": {"type": "session.switchAgent", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "agent": "build"}}}
 {"type": "emit_inbound", "label": "session.switchAgent.response.2", "frame": {"type": "sdk.response", "operation": "session.switchAgent", "data": null}}
@@ -64,7 +64,7 @@
 {"type": "expect_outbound", "label": "session.switchModel", "frame": {"type": "session.switchModel", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "model": {"providerID": "opencode", "id": "nemotron-3.5-lightning-free"}}}}
 {"type": "emit_inbound", "label": "session.switchModel.response", "frame": {"type": "sdk.response", "operation": "session.switchModel", "data": null}}
 {"type": "emit_inbound", "label": "session.model.selected", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb7eef8d001Yy5fmSDr6nQ8OS", "created": 1790657359757, "type": "session.model.selected", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "model": {"id": "nemotron-3.5-lightning-free", "providerID": "opencode"}, "previous": {"id": "big-pickle", "providerID": "opencode", "variant": "default"}}, "durable": {"aggregateID": "ses_f14812197ffeCbw641wM2r3ZmP", "seq": 18, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put.2", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put.2", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response.2", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
 {"type": "expect_outbound", "label": "session.prompt.2", "frame": {"type": "session.prompt", "input": {"sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "text": "<any>"}}}
 {"type": "emit_inbound", "label": "session.prompt.response.2", "frame": {"type": "sdk.response", "operation": "session.prompt", "data": {"data": {"id": "msg_0eb7eef95001lHN9WhCH6Q9l6w", "sessionID": "ses_f14812197ffeCbw641wM2r3ZmP", "time": {"created": 1790657359766}, "type": "user", "payload": {"text": "Reply exactly SWITCHED."}, "delivery": "steer"}}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_tool_call/opencode_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_tool_call/opencode_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/opencode2_tool_call/opencode_transcript.ndjson
@@ -8,3 +8,3 @@
 {"type": "emit_inbound", "label": "session.created", "frame": {"type": "sdk.event", "event": {"id": "evt_0eb735d32001oBstTIapVlESgH", "created": 1790656601394, "type": "session.created", "location": {"directory": "<work>"}, "data": {"sessionID": "ses_f148ca2deffeJcwCnRQtb0YFNX", "slug": "shiny-pixel", "version": "2.0.18", "projectID": "global", "location": {"directory": "<work>"}, "subpath": "", "title": "spike tool_call", "model": {"id": "big-pickle", "providerID": "opencode"}}, "durable": {"aggregateID": "ses_f148ca2deffeJcwCnRQtb0YFNX", "seq": 0, "version": 1}}}}
-{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f148ca2deffeJcwCnRQtb0YFNX", "key": "t3-code", "value": "<any>"}}}
+{"type": "expect_outbound", "label": "session.instructions.entry.put", "frame": {"type": "session.instructions.entry.put", "input": {"sessionID": "ses_f148ca2deffeJcwCnRQtb0YFNX", "key": "goat", "value": "<any>"}}}
 {"type": "emit_inbound", "label": "session.instructions.entry.put.response", "frame": {"type": "sdk.response", "operation": "session.instructions.entry.put", "data": null}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/pi_compaction/pi_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/pi_compaction/pi_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/pi_compaction/pi_transcript.ndjson
@@ -3,3 +3,3 @@
 {"type":"expect_outbound","label":"get_state","frame":{"type":"get_state","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:get_state","frame":{"id":"t3-0","type":"response","command":"get_state","success":true,"data":{"model":{"type":"chat","id":"deepseek/deepseek-v4-flash","name":"DeepSeek: DeepSeek V4 Flash 0423","api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","provider":"openrouter","reasoning":true,"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":"xhigh","max":null},"input":["text"],"cost":{"input":0.04186,"output":0.08372,"cacheRead":0.008372,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"compat":{"supportsDeveloperRole":false,"thinkingFormat":"openrouter","supportsStrictMode":true,"sendSessionAffinityHeaders":true,"requiresReasoningContentOnAssistantMessages":true}},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"/pi-sessions/session-1.jsonl","sessionId":"00000000-0000-4000-8000-000000000002","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_transcript.ndjson
@@ -3,3 +3,3 @@
 {"type":"expect_outbound","label":"get_state","frame":{"type":"get_state","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:get_state","frame":{"id":"t3-0","type":"response","command":"get_state","success":true,"data":{"model":{"type":"chat","id":"deepseek/deepseek-v4-flash","name":"DeepSeek: DeepSeek V4 Flash 0423","api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","provider":"openrouter","reasoning":true,"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":"xhigh","max":null},"input":["text"],"cost":{"input":0.04186,"output":0.08372,"cacheRead":0.008372,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"compat":{"supportsDeveloperRole":false,"thinkingFormat":"openrouter","supportsStrictMode":true,"sendSessionAffinityHeaders":true,"requiresReasoningContentOnAssistantMessages":true}},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"/pi-sessions/session-1.jsonl","sessionId":"00000000-0000-4000-8000-000000000002","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}}
@@ -61,5 +61,5 @@
 {"type":"expect_outbound","label":"switch_session@p2","frame":{"type":"switch_session","sessionPath":"/pi-sessions/session-1.jsonl","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000003","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000004","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000005","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000003","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000004","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000005","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:switch_session@p2","frame":{"id":"t3-0","type":"response","command":"switch_session","success":true,"data":{"cancelled":false}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/grok_transcript.ndjson
@@ -25,4 +25,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790300065163,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: first fixture turn complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: first fixture turn complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: first fixture turn complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with exactly: first fixture turn complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
@@ -56,4 +56,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790300067131,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-2","version":0,"kind":"prompt","text":"Respond with exactly: second fixture turn complete\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-2","runningText":"Respond with exactly: second fixture turn complete\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-2","version":0,"kind":"prompt","text":"Respond with exactly: second fixture turn complete\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-2","runningText":"Respond with exactly: second fixture turn complete\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:session/update:agent_thought_chunk","frame":{"kind":"notification","method":"session/update","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The"}},"_meta":{"totalTokens":22480,"eventId":"00000000-0000-4000-8000-000000000001-31","agentTimestampMs":1790300068257,"promptId":"t3-xai-prompt-2","streamStartMs":1790300067703,"turnStartMs":1790300067162,"updateType":"AgentThoughtChunk","chunkId":1}}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson
@@ -26,4 +26,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790301055553,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with the following text: fixture simple ok\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with the following text: fixture simple ok\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with the following text: fixture simple ok\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nRespond with the following text: fixture simple ok\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/simple/muse_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/simple/muse_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/simple/muse_transcript.ndjson
@@ -9,3 +9,3 @@
 {"type":"emit_inbound","label":"session/approvalModeChanged","frame":{"jsonrpc":"2.0","method":"session/approvalModeChanged","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","viewCursor":"v:01a11a6a-bbb5-7000-ad0b-0c9e728406e5:1","sourceRange":{"stream":{"kind":"session","id":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5"},"first":{"id":"cfd043e8-8728-493d-ba28-252ef91e8a80","sequence":5},"last":{"id":"cfd043e8-8728-493d-ba28-252ef91e8a80","sequence":5}},"mode":"allowAll","source":"approvalReconfigure","commandId":"01a11a6a-bbb6-7000-b1a4-a01ea59676ef","clientName":"t3_code"},"emittedAtMs":1791444565340}}
-{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Respond with the following text: fixture simple ok"}],"displayText":"Respond with the following text: fixture simple ok","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6a-be41-7000-8db9-1d84c1b8be48"}}}
+{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Respond with the following text: fixture simple ok"}],"displayText":"Respond with the following text: fixture simple ok","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6a-be41-7000-8db9-1d84c1b8be48"}}}
 {"type":"emit_inbound","label":"session/branchChanged","frame":{"jsonrpc":"2.0","method":"session/branchChanged","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","viewCursor":"v:01a11a6a-bbb5-7000-ad0b-0c9e728406e5:2","sourceRange":{"stream":{"kind":"session","id":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5"},"first":{"id":"0f64f4ea-a08c-43e1-af53-cf85cee1a11c","sequence":16},"last":{"id":"0f64f4ea-a08c-43e1-af53-cf85cee1a11c","sequence":16}},"workspaceRoot":"<workspace>","branch":"main","vcs":"git"},"emittedAtMs":1791444565612}}
@@ -14,4 +14,4 @@
 {"type":"emit_inbound","label":"turn/started","frame":{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","viewCursor":"v:01a11a6a-bbb5-7000-ad0b-0c9e728406e5:3","sourceRange":{"stream":{"kind":"session","id":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5"},"first":{"id":"1f33a521-7829-4cc3-97db-a3b5a6e7deaf","sequence":18},"last":{"id":"1f33a521-7829-4cc3-97db-a3b5a6e7deaf","sequence":18}},"turnId":"01a11a6a-be41-7000-8db9-1d84c1b8be48","commandId":"01a11a6a-be41-7000-8db9-1d84c1b8be48"},"emittedAtMs":1791444565635}}
-{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","viewCursor":"v:01a11a6a-bbb5-7000-ad0b-0c9e728406e5:4","sourceRange":{"stream":{"kind":"session","id":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5"},"first":{"id":"1f33a521-7829-4cc3-97db-a3b5a6e7deaf","sequence":18},"last":{"id":"1f33a521-7829-4cc3-97db-a3b5a6e7deaf","sequence":18}},"item":{"itemId":"23294b54-8e67-4896-a7f3-681119e1ddbe","kind":"userMessage","turnId":"01a11a6a-be41-7000-8db9-1d84c1b8be48","revision":1,"status":"completed","recordedAt":"2026-10-08T07:29:25.627042Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with the following text: fixture simple ok","commandId":"01a11a6a-be41-7000-8db9-1d84c1b8be48"}},"emittedAtMs":1791444565635}}
-{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","viewCursor":"v:01a11a6a-bbb5-7000-ad0b-0c9e728406e5:5","sourceRange":{"stream":{"kind":"session","id":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5"},"first":{"id":"8c00aa21-7809-4cb2-89f7-b499aaa8746d","sequence":20},"last":{"id":"8c00aa21-7809-4cb2-89f7-b499aaa8746d","sequence":20}},"item":{"itemId":"23294b54-8e67-4896-a7f3-681119e1ddbe","kind":"userMessage","turnId":"01a11a6a-be41-7000-8db9-1d84c1b8be48","revision":2,"status":"completed","recordedAt":"2026-10-08T07:29:25.643029Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with the following text: fixture simple ok","displayText":"Respond with the following text: fixture simple ok","commandId":"01a11a6a-be41-7000-8db9-1d84c1b8be48"}},"emittedAtMs":1791444565652}}
+{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","viewCursor":"v:01a11a6a-bbb5-7000-ad0b-0c9e728406e5:4","sourceRange":{"stream":{"kind":"session","id":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5"},"first":{"id":"1f33a521-7829-4cc3-97db-a3b5a6e7deaf","sequence":18},"last":{"id":"1f33a521-7829-4cc3-97db-a3b5a6e7deaf","sequence":18}},"item":{"itemId":"23294b54-8e67-4896-a7f3-681119e1ddbe","kind":"userMessage","turnId":"01a11a6a-be41-7000-8db9-1d84c1b8be48","revision":1,"status":"completed","recordedAt":"2026-10-08T07:29:25.627042Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with the following text: fixture simple ok","commandId":"01a11a6a-be41-7000-8db9-1d84c1b8be48"}},"emittedAtMs":1791444565635}}
+{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","viewCursor":"v:01a11a6a-bbb5-7000-ad0b-0c9e728406e5:5","sourceRange":{"stream":{"kind":"session","id":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5"},"first":{"id":"8c00aa21-7809-4cb2-89f7-b499aaa8746d","sequence":20},"last":{"id":"8c00aa21-7809-4cb2-89f7-b499aaa8746d","sequence":20}},"item":{"itemId":"23294b54-8e67-4896-a7f3-681119e1ddbe","kind":"userMessage","turnId":"01a11a6a-be41-7000-8db9-1d84c1b8be48","revision":2,"status":"completed","recordedAt":"2026-10-08T07:29:25.643029Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Respond with the following text: fixture simple ok","displayText":"Respond with the following text: fixture simple ok","commandId":"01a11a6a-be41-7000-8db9-1d84c1b8be48"}},"emittedAtMs":1791444565652}}
 {"type":"emit_inbound","label":"item/started","frame":{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5","viewCursor":"v:01a11a6a-bbb5-7000-ad0b-0c9e728406e5:6","sourceRange":{"stream":{"kind":"session","id":"01a11a6a-bbb5-7000-ad0b-0c9e728406e5"},"first":{"id":"ed1680a5-6f99-4b0f-b9ea-d12193f0de1f","sequence":37},"last":{"id":"ed1680a5-6f99-4b0f-b9ea-d12193f0de1f","sequence":37}},"item":{"itemId":"ed1680a5-6f99-4b0f-b9ea-d12193f0de1f","kind":"reminderChild","turnId":"01a11a6a-be41-7000-8db9-1d84c1b8be48","revision":1,"status":"inProgress","recordedAt":"2026-10-08T07:29:25.781511Z","fallbackText":"Reminder child session","childSessionId":"9785bf9d-382d-4781-ab3b-3817c9e6a604","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a11a6a-bef1-7032-974a-059b8765c487"}},"emittedAtMs":1791444565789}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_transcript.ndjson
@@ -3,3 +3,3 @@
 {"type":"expect_outbound","label":"get_state","frame":{"type":"get_state","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:get_state","frame":{"id":"t3-0","type":"response","command":"get_state","success":true,"data":{"model":{"type":"chat","id":"deepseek/deepseek-v4-flash","name":"DeepSeek: DeepSeek V4 Flash 0423","api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","provider":"openrouter","reasoning":true,"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":"xhigh","max":null},"input":["text"],"cost":{"input":0.04186,"output":0.08372,"cacheRead":0.008372,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"compat":{"supportsDeveloperRole":false,"thinkingFormat":"openrouter","supportsStrictMode":true,"sendSessionAffinityHeaders":true,"requiresReasoningContentOnAssistantMessages":true}},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"/pi-sessions/session-1.jsonl","sessionId":"00000000-0000-4000-8000-000000000002","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback/pi_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback/pi_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback/pi_transcript.ndjson
@@ -3,3 +3,3 @@
 {"type":"expect_outbound","label":"get_state","frame":{"type":"get_state","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:get_state","frame":{"id":"t3-0","type":"response","command":"get_state","success":true,"data":{"model":{"type":"chat","id":"deepseek/deepseek-v4-flash","name":"DeepSeek: DeepSeek V4 Flash 0423","api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","provider":"openrouter","reasoning":true,"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":"xhigh","max":null},"input":["text"],"cost":{"input":0.04186,"output":0.08372,"cacheRead":0.008372,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"compat":{"supportsDeveloperRole":false,"thinkingFormat":"openrouter","supportsStrictMode":true,"sendSessionAffinityHeaders":true,"requiresReasoningContentOnAssistantMessages":true}},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"/pi-sessions/session-1.jsonl","sessionId":"00000000-0000-4000-8000-000000000002","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}}
@@ -82,4 +82,4 @@
 {"type":"expect_outbound","label":"fork","frame":{"type":"fork","entryId":"022fe9c1","id":"t3-12"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000003","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000004","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000003","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000004","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:fork","frame":{"id":"t3-12","type":"response","command":"fork","success":true,"data":{"text":"Respond with exactly: rollback fixture second turn complete","cancelled":false}}}
@@ -90,4 +90,4 @@
 {"type":"expect_outbound","label":"switch_session","frame":{"type":"switch_session","sessionPath":"/pi-sessions/session-2.jsonl","id":"t3-15"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000006","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000007","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000006","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000007","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:switch_session","frame":{"id":"t3-15","type":"response","command":"switch_session","success":true,"data":{"cancelled":false}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson
@@ -3,3 +3,3 @@
 {"type":"expect_outbound","label":"get_state","frame":{"type":"get_state","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:get_state","frame":{"id":"t3-0","type":"response","command":"get_state","success":true,"data":{"model":{"type":"chat","id":"deepseek/deepseek-v4-flash","name":"DeepSeek: DeepSeek V4 Flash 0423","api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","provider":"openrouter","reasoning":true,"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":"xhigh","max":null},"input":["text"],"cost":{"input":0.04186,"output":0.08372,"cacheRead":0.008372,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"compat":{"supportsDeveloperRole":false,"thinkingFormat":"openrouter","supportsStrictMode":true,"sendSessionAffinityHeaders":true,"requiresReasoningContentOnAssistantMessages":true}},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"/pi-sessions/session-1.jsonl","sessionId":"00000000-0000-4000-8000-000000000002","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}}
@@ -151,5 +151,5 @@
 {"type":"expect_outbound","label":"switch_session@p2","frame":{"type":"switch_session","sessionPath":"/pi-sessions/session-1.jsonl","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000003","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000004","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000005","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000003","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000004","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000005","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:switch_session@p2","frame":{"id":"t3-0","type":"response","command":"switch_session","success":true,"data":{"cancelled":false}}}
@@ -205,4 +205,4 @@
 {"type":"expect_outbound","label":"fork@p2","frame":{"type":"fork","entryId":"ee73daae","id":"t3-10"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000006","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000007","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000006","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000007","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:fork@p2","frame":{"id":"t3-10","type":"response","command":"fork","success":true,"data":{"text":"Run this exact local command: `node -e \"console.log('interrupt fixture tool started'); setTimeout(() => {}, 30000)\"`. Do not answer until it completes, then respond exactly: interrupt fixture should not finish naturally.","cancelled":false}}}
@@ -213,4 +213,4 @@
 {"type":"expect_outbound","label":"switch_session@p2","frame":{"type":"switch_session","sessionPath":"/pi-sessions/session-2.jsonl","id":"t3-13"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000009","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
-{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000010","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000009","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request@p2","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000010","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:switch_session@p2","frame":{"id":"t3-13","type":"response","command":"switch_session","success":true,"data":{"cancelled":false}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/todo_list/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/todo_list/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/todo_list/grok_transcript.ndjson
@@ -25,4 +25,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":true,"activity":"working","resident":true,"lastChangeUnixMs":1790329153513,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nUse the update_plan tool to track exactly three steps: inspect package.json, inspect tsconfig.json, report completion. Then read package.json and tsconfig.json, and answer exactly: todo list fixture complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nUse the update_plan tool to track exactly three steps: inspect package.json, inspect tsconfig.json, report completion. Then read package.json and tsconfig.json, and answer exactly: todo list fixture complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nUse the update_plan tool to track exactly three steps: inspect package.json, inspect tsconfig.json, report completion. Then read package.json and tsconfig.json, and answer exactly: todo list fixture complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nUse the update_plan tool to track exactly three steps: inspect package.json, inspect tsconfig.json, report completion. Then read package.json and tsconfig.json, and answer exactly: todo list fixture complete\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
@@ -145,3 +145,3 @@
 {"type":"emit_inbound","label":"notification:_x.ai/session_notification:tool_call_delta_chunk","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call_delta_chunk","tool_call_id":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","tool_index":0,"name":"search_tool"}}}}
-{"type":"emit_inbound","label":"notification:_x.ai/session_notification:tool_call_delta_chunk","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call_delta_chunk","tool_index":0,"arguments_delta":"{\"query\":\"t3-code plan todo\",\"limit\":10}"}}}}
+{"type":"emit_inbound","label":"notification:_x.ai/session_notification:tool_call_delta_chunk","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call_delta_chunk","tool_index":0,"arguments_delta":"{\"query\":\"goat plan todo\",\"limit\":10}"}}}}
 {"type":"emit_inbound","label":"notification:_x.ai/session_notification:tool_call_delta_chunk","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call_delta_chunk","tool_call_id":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-2","tool_index":1,"name":"list_dir"}}}}
@@ -150,5 +150,5 @@
 {"type":"emit_inbound","label":"notification:_x.ai/session_notification:response_completed","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"response_completed","usage":{"input_tokens":306,"output_tokens":230,"cache_read_input_tokens":22528,"cache_creation_input_tokens":0,"reasoning_tokens":168},"signature":"Mc7ADqrVIJ7hdWXyCqMAjvwCSA94WKam59bVRWt30N1eOlah8ScVKeaNWgc7wwZPqdHa67WyJpZFkfx+V2TfvRkUfT2gH6EgLgp1Um6/PtgTZZ2uxTok5Oz37DcahUZo6kkQixR5UOpILTENWZLzvRYG8GNYqm4710fu1E8b85TniG29+tBoJHQJ0ixOa6kAU20Oc/mUQNcmcjNQ5ZP33/yVqXmK+CrypDOf/AwQXBX4LQepzs8zFd2eFYm2WJjMGaNBL35UVqWNpw9QBgpkQDfoyKF17JnsG02bfdJFNBSferLx7WpgbiewAh4zRPuKp+e5GNOGAOzfdJiSL1XvavizKdemD/Du065QFgEzlJ/7QR+VTpyqwYp4VbAJ6C3gvpInR22p8sSZR79vIOT1R6y24qaQ2qPQTfnlMSM+GUDPJE0vCc5uAjrvOEYblW/M7ey/KQ7e32rOO4hBLHkGaMM2XrjIMFwrKKlobfAEj0S2Uft+XctWdOa6uvISf75cvRp1KYtBlM9JVviPsovkSiv56QIVsL65vxFF9ia/1T698AorLXzm09xTvHAVIe/6NKNpj3zKCM1KyoIs151xANXq4aR6hHqUL+N7OaWo1zZT9NkUIUjqYa1MdSvKhMVdw2qFyAv8QTqXJukJT/ihWOujpMo7Wtu7J6djTqKdfCNNUiIzy/k1bvgzLi9hbrcDnmf+nu7qBVjvQxRXYCXv135fS3Bw0aVBt3V8N71sxCi7yB1Vr0wInv0Z6Emku7VQdclLg6ZMozXNCKgOXKraAR4f7OISZF5i6JrRXsbTzXvK4dumyAP9IqdiGtbAKDMtFxTn5vaBQRsNdxdJlX00emVZMpV7B4WK+NAXJvXEwT+H9vvr8D9rCY9H7Jeke/eQ5yHu8WvFBgfsZb3DXKeCJzkGYkmwdAUd1KGHFdq1C+3a9+L2P7ql3Y3RLYbDzuj1SUUspMtGPlYCkGIfiyKdEmzKEhg4yaTpRKNo0OXxGLYJ0hrATcYHzI66lyVy8G0V2c/BDDkcx1F5Gd8aSiVxF5+5xq8AKeQ5zBl7c7N/92XkBb/G5xMs/9MYZtwE6TfnKnDj"}}}}
-{"type":"emit_inbound","label":"notification:session/update:tool_call","frame":{"kind":"notification","method":"session/update","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call","toolCallId":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","title":"search_tool","rawInput":{"query":"t3-code plan todo","limit":10},"_meta":{"x.ai/tool":{"version":1,"name":"search_tool","kind":"search_tool","namespace":"grok_build","label":"Search Tools","read_only":false}}},"_meta":{"totalTokens":23068,"eventId":"00000000-0000-4000-8000-000000000001-117","agentTimestampMs":1790329159910,"promptId":"t3-xai-prompt-1","streamStartMs":1790329156736,"turnStartMs":1790329153545,"updateType":"ToolCall","updateParams":{"toolCallId":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","title":"search_tool","kind":"Other","status":"Pending"}}}}}
+{"type":"emit_inbound","label":"notification:session/update:tool_call","frame":{"kind":"notification","method":"session/update","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call","toolCallId":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","title":"search_tool","rawInput":{"query":"goat plan todo","limit":10},"_meta":{"x.ai/tool":{"version":1,"name":"search_tool","kind":"search_tool","namespace":"grok_build","label":"Search Tools","read_only":false}}},"_meta":{"totalTokens":23068,"eventId":"00000000-0000-4000-8000-000000000001-117","agentTimestampMs":1790329159910,"promptId":"t3-xai-prompt-1","streamStartMs":1790329156736,"turnStartMs":1790329153545,"updateType":"ToolCall","updateParams":{"toolCallId":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","title":"search_tool","kind":"Other","status":"Pending"}}}}}
 {"type":"emit_inbound","label":"notification:_x.ai/session_notification:pending_interaction","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"pending_interaction","tool_call_id":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","kind":"permission"}}}}
-{"type":"emit_inbound","label":"notification:session/update:tool_call_update","frame":{"kind":"notification","method":"session/update","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","kind":"other","title":"Search tools: \"t3-code plan todo\"","locations":[],"rawInput":{"variant":"SearchTool","query":"t3-code plan todo","limit":10},"_meta":{"x.ai/tool":{"version":1,"name":"search_tool","kind":"search_tool","namespace":"grok_build","label":"Search Tools","read_only":false}}},"_meta":{"totalTokens":23068,"eventId":"00000000-0000-4000-8000-000000000001-118","agentTimestampMs":1790329159910,"promptId":"t3-xai-prompt-1","streamStartMs":1790329156736,"turnStartMs":1790329153545,"updateType":"ToolCallUpdate","updateParams":{"toolCallId":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","status":null}}}}}
+{"type":"emit_inbound","label":"notification:session/update:tool_call_update","frame":{"kind":"notification","method":"session/update","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","kind":"other","title":"Search tools: \"goat plan todo\"","locations":[],"rawInput":{"variant":"SearchTool","query":"goat plan todo","limit":10},"_meta":{"x.ai/tool":{"version":1,"name":"search_tool","kind":"search_tool","namespace":"grok_build","label":"Search Tools","read_only":false}}},"_meta":{"totalTokens":23068,"eventId":"00000000-0000-4000-8000-000000000001-118","agentTimestampMs":1790329159910,"promptId":"t3-xai-prompt-1","streamStartMs":1790329156736,"turnStartMs":1790329153545,"updateType":"ToolCallUpdate","updateParams":{"toolCallId":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1","status":null}}}}}
 {"type":"emit_inbound","label":"notification:_x.ai/session_notification:interaction_resolved","frame":{"kind":"notification","method":"_x.ai/session_notification","params":{"sessionId":"00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"interaction_resolved","tool_call_id":"call-30b045aa-32fd-4c38-8271-33bae722ed1d-1"}}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/grok_transcript.ndjson
@@ -26,4 +26,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790329142568,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nCreate or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nCreate or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nCreate or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nCreate or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"emit_inbound","label":"notification:_x.ai/models/update","frame":{"kind":"notification","method":"_x.ai/models/update","params":{"currentModelId":"grok-4.7","availableModels":[{"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.7-build-fast","name":"Grok 4.7 Fast","description":"Fast variant. 2x the price.","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},{"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},{"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},{"modelId":"grok-4.6","name":"Grok 4.6","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"xhigh","value":"xhigh","label":"Extra High","description":"Highest effort and reasoning level","default":false},{"id":"high","value":"high","label":"High","description":"Higher implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}},{"modelId":"grok-4.5","name":"Grok 4.5","_meta":{"totalContextTokens":500000,"agentType":"grok-build-plan","supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[{"id":"high","value":"high","label":"High","description":"Highest implementation quality with extensive reasoning","default":true},{"id":"medium","value":"medium","label":"Medium","description":"Balanced effort with standard implementation and testing","default":false},{"id":"low","value":"low","label":"Low","description":"Quick, fast implementations","default":false}]}}]}}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/grok_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/grok_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/grok_transcript.ndjson
@@ -25,4 +25,4 @@
 {"type":"emit_inbound","label":"notification:_x.ai/sessions/changed","frame":{"kind":"notification","method":"_x.ai/sessions/changed","params":{"upserted":[{"sessionId":"00000000-0000-4000-8000-000000000001","title":null,"cwd":"<workspace>","isWorktree":false,"modelId":"grok-4.7","reasoningEffort":"high","yolo":false,"activity":"working","resident":true,"lastChangeUnixMs":1790300234968,"origin":{"kind":"local"}}],"removed":[]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nDo not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
-{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nDo not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[{"id":"t3-xai-prompt-1","version":0,"kind":"prompt","text":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nDo not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","position":0}]}}}
+{"type":"emit_inbound","label":"notification:_x.ai/queue/changed","frame":{"kind":"notification","method":"_x.ai/queue/changed","params":{"sessionId":"00000000-0000-4000-8000-000000000001","entries":[],"runningPromptId":"t3-xai-prompt-1","runningText":"<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.\n</t3_code_instructions>\n\n<user_request>\nDo not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.\n</user_request>\n\n<runtime_info>In case you're asked: you are running in T3 Code through the Grok harness, as grok-build. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.\n</pull_request_linking>","runningKind":"prompt"}}}
 {"type":"runtime_exit","status":"cancelled"}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/muse_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/muse_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/muse_transcript.ndjson
@@ -9,3 +9,3 @@
 {"type":"emit_inbound","label":"session/approvalModeChanged","frame":{"jsonrpc":"2.0","method":"session/approvalModeChanged","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","viewCursor":"v:01a11a6d-2d3d-7000-8178-411fdb90bc34:1","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-2d3d-7000-8178-411fdb90bc34"},"first":{"id":"9865268e-0a39-43a0-89d0-251a820ec8a3","sequence":5},"last":{"id":"9865268e-0a39-43a0-89d0-251a820ec8a3","sequence":5}},"mode":"allowAll","source":"approvalReconfigure","commandId":"01a11a6d-2d3e-7000-b0e7-f04c53ee070b","clientName":"t3_code"},"emittedAtMs":1791444725268}}
-{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally."}],"displayText":"Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5"}}}
+{"type":"expect_outbound","label":"turn/start","frame":{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","input":[{"type":"text","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>"},{"type":"text","text":"Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally."}],"displayText":"Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.","workspaceRoots":["<workspace>"],"ifBusy":"queue","reasoningEffort":"high","commandId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5"}}}
 {"type":"emit_inbound","label":"session/branchChanged","frame":{"jsonrpc":"2.0","method":"session/branchChanged","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","viewCursor":"v:01a11a6d-2d3d-7000-8178-411fdb90bc34:2","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-2d3d-7000-8178-411fdb90bc34"},"first":{"id":"531b0e9e-c96d-4fa5-a6dd-5cc7d4569543","sequence":16},"last":{"id":"531b0e9e-c96d-4fa5-a6dd-5cc7d4569543","sequence":16}},"workspaceRoot":"<workspace>","branch":"main","vcs":"git"},"emittedAtMs":1791444725509}}
@@ -15,4 +15,4 @@
 {"type":"emit_inbound","label":"turn/started","frame":{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","viewCursor":"v:01a11a6d-2d3d-7000-8178-411fdb90bc34:3","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-2d3d-7000-8178-411fdb90bc34"},"first":{"id":"50d1fd8c-232b-47b9-9bfa-9b543961bbc9","sequence":18},"last":{"id":"50d1fd8c-232b-47b9-9bfa-9b543961bbc9","sequence":18}},"turnId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5","commandId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5"},"emittedAtMs":1791444725523}}
-{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","viewCursor":"v:01a11a6d-2d3d-7000-8178-411fdb90bc34:4","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-2d3d-7000-8178-411fdb90bc34"},"first":{"id":"50d1fd8c-232b-47b9-9bfa-9b543961bbc9","sequence":18},"last":{"id":"50d1fd8c-232b-47b9-9bfa-9b543961bbc9","sequence":18}},"item":{"itemId":"cfa989ad-2359-4da2-9fca-562855cc0ae8","kind":"userMessage","turnId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5","revision":1,"status":"completed","recordedAt":"2026-10-08T07:32:05.510508Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.","commandId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5"}},"emittedAtMs":1791444725523}}
-{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","viewCursor":"v:01a11a6d-2d3d-7000-8178-411fdb90bc34:5","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-2d3d-7000-8178-411fdb90bc34"},"first":{"id":"5db75d92-0e52-4bce-bb81-40e254b40bc3","sequence":20},"last":{"id":"5db75d92-0e52-4bce-bb81-40e254b40bc3","sequence":20}},"item":{"itemId":"cfa989ad-2359-4da2-9fca-562855cc0ae8","kind":"userMessage","turnId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5","revision":2,"status":"completed","recordedAt":"2026-10-08T07:32:05.530992Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.","displayText":"Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.","commandId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5"}},"emittedAtMs":1791444725539}}
+{"type":"emit_inbound","label":"item/completed","frame":{"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","viewCursor":"v:01a11a6d-2d3d-7000-8178-411fdb90bc34:4","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-2d3d-7000-8178-411fdb90bc34"},"first":{"id":"50d1fd8c-232b-47b9-9bfa-9b543961bbc9","sequence":18},"last":{"id":"50d1fd8c-232b-47b9-9bfa-9b543961bbc9","sequence":18}},"item":{"itemId":"cfa989ad-2359-4da2-9fca-562855cc0ae8","kind":"userMessage","turnId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5","revision":1,"status":"completed","recordedAt":"2026-10-08T07:32:05.510508Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.","commandId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5"}},"emittedAtMs":1791444725523}}
+{"type":"emit_inbound","label":"item/updated","frame":{"jsonrpc":"2.0","method":"item/updated","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","viewCursor":"v:01a11a6d-2d3d-7000-8178-411fdb90bc34:5","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-2d3d-7000-8178-411fdb90bc34"},"first":{"id":"5db75d92-0e52-4bce-bb81-40e254b40bc3","sequence":20},"last":{"id":"5db75d92-0e52-4bce-bb81-40e254b40bc3","sequence":20}},"item":{"itemId":"cfa989ad-2359-4da2-9fca-562855cc0ae8","kind":"userMessage","turnId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5","revision":2,"status":"completed","recordedAt":"2026-10-08T07:32:05.530992Z","text":"<runtime_info>In case you're asked: you are running in T3 Code through the Muse Code harness, as muse-spark-1.3-contributor with high reasoning effort. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the goat MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.","displayText":"Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.","commandId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5"}},"emittedAtMs":1791444725539}}
 {"type":"emit_inbound","label":"item/started","frame":{"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"01a11a6d-2d3d-7000-8178-411fdb90bc34","viewCursor":"v:01a11a6d-2d3d-7000-8178-411fdb90bc34:6","sourceRange":{"stream":{"kind":"session","id":"01a11a6d-2d3d-7000-8178-411fdb90bc34"},"first":{"id":"ae604001-22b9-479c-a45b-3dcfed45996c","sequence":37},"last":{"id":"ae604001-22b9-479c-a45b-3dcfed45996c","sequence":37}},"item":{"itemId":"ae604001-22b9-479c-a45b-3dcfed45996c","kind":"reminderChild","turnId":"01a11a6d-2ee0-7000-be19-f20eda7ce5d5","revision":1,"status":"inProgress","recordedAt":"2026-10-08T07:32:05.638142Z","fallbackText":"Reminder child session","childSessionId":"1f58196a-6bf6-42da-9499-8f53a439e6e1","reminderAgentId":"skill-reminder","generationId":1,"taskId":"01a11a6d-2f65-70b1-bb8f-69b33bb4fc62"}},"emittedAtMs":1791444725646}}
```

### MODIFY `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/pi_transcript.ndjson`

Replay-derived fixture adaptation only: preserve command/event ids, timestamps and ordering; update application-owned MCP identity/instructions and dual deny rows. These are edited replay inputs, not newly captured provider evidence.

```diff
--- a/apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/pi_transcript.ndjson
+++ b/apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/pi_transcript.ndjson
@@ -3,3 +3,3 @@
 {"type":"expect_outbound","label":"get_state","frame":{"type":"get_state","id":"t3-0"}}
-{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
+{"type":"emit_inbound","label":"extension_ui_request","frame":{"type":"extension_ui_request","id":"00000000-0000-4000-8000-000000000001","method":"notify","message":"goat MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.","notifyType":"warning"}}
 {"type":"emit_inbound","label":"response:get_state","frame":{"id":"t3-0","type":"response","command":"get_state","success":true,"data":{"model":{"type":"chat","id":"deepseek/deepseek-v4-flash","name":"DeepSeek: DeepSeek V4 Flash 0423","api":"openai-completions","baseUrl":"https://openrouter.ai/api/v1","provider":"openrouter","reasoning":true,"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":"xhigh","max":null},"input":["text"],"cost":{"input":0.04186,"output":0.08372,"cacheRead":0.008372,"cacheWrite":0},"contextWindow":1048576,"maxTokens":131072,"compat":{"supportsDeveloperRole":false,"thinkingFormat":"openrouter","supportsStrictMode":true,"sendSessionAffinityHeaders":true,"requiresReasoningContentOnAssistantMessages":true}},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"/pi-sessions/session-1.jsonl","sessionId":"00000000-0000-4000-8000-000000000002","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}}
```

### MODIFY `apps/server/src/mcp/McpHttpServer.ts`

Amend only the existing provider reconnect comment; wp3 owns McpServer name and toolkit changes.

```diff
--- a/apps/server/src/mcp/McpHttpServer.ts
+++ b/apps/server/src/mcp/McpHttpServer.ts
@@ -165,7 +165,7 @@
         : undefined);
     if (!invocation) {
       // Without this the only symptom of a dead credential is the agent
-      // quietly losing the whole `t3-code` toolkit for the rest of its
+      // quietly losing the whole `goat` toolkit for the rest of its
       // session, with nothing on the server to explain why.
       yield* Effect.logWarning("rejected MCP request with an unusable credential", {
         reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
```

### MODIFY `packages/provider-opencode/src/server/adapter.test.ts`

Exercise the actual OpenCode 1 openSession boundary: inject goat with scoped HTTP credential only for a managed server, and inject nothing for external servers or absent credentials.

```diff
--- a/packages/provider-opencode/src/server/adapter.test.ts
+++ b/packages/provider-opencode/src/server/adapter.test.ts
@@ -3,6 +3,7 @@
 import type { OpencodeClient, ToolPart } from "@opencode-ai/sdk/v2";
 import {
   CheckpointId,
+  EnvironmentId,
   NodeId,
   ProjectId,
   ProviderInstanceId,
@@ -148,6 +149,7 @@
   suffix: string,
   nativeSessionId: string,
   client: object,
+  options: { readonly external?: boolean } = {},
 ) {
   const instanceId = ProviderInstanceId.make(`opencode-${suffix}`);
   const threadId = ThreadId.make(`thread-opencode-${suffix}`);
@@ -163,7 +165,8 @@
     environment: {},
   }).pipe(
     Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
-      connectToOpenCodeServer: () => Effect.succeed({ url: "http://test.invalid", external: true }),
+      connectToOpenCodeServer: () =>
+        Effect.succeed({ url: "http://test.invalid", external: options.external ?? true }),
       createOpenCodeSdkClient: () => client,
     } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
     Effect.provideService(ProviderHost.ProviderHost, {
@@ -241,6 +244,59 @@
 });

 describe("OpenCodeAdapterV2", () => {
+  it.effect.each([
+    { external: false, withCredential: true },
+    { external: true, withCredential: true },
+    { external: false, withCredential: false },
+  ])("injects goat only into an owned server with a credential: %j", ({ external, withCredential }) =>
+    Effect.gen(function* () {
+      const suffix = `goat-registration-${external}-${withCredential}`;
+      const sessions = yield* McpProviderSessions.McpProviderSessions;
+      if (withCredential) {
+        yield* sessions.set({
+          environmentId: EnvironmentId.make("environment:goat-registration"),
+          threadId: ThreadId.make(`thread-opencode-${suffix}`),
+          providerSessionId: "mcp:goat-registration",
+          providerInstanceId: ProviderInstanceId.make(`opencode-${suffix}`),
+          endpoint: "http://fixture.invalid/mcp",
+          authorizationHeader: "Bearer scoped-goat-token",
+          browserToolsAvailable: false,
+        });
+      }
+      const registrations: unknown[] = [];
+      const nativeEvents = asyncEventStream();
+      yield* makeOpenCodeRuntimeHarness(suffix, "goat-registration", {
+        event: {
+          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
+            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
+            return { stream: nativeEvents.stream };
+          },
+        },
+        session: {
+          create: async () => ({ data: { id: "goat-registration", time: { created: 1, updated: 1 } } }),
+        },
+        mcp: {
+          add: async (input: unknown) => {
+            registrations.push(input);
+            return { data: true };
+          },
+        },
+      }, { external });
+      assert.deepEqual(registrations, !external && withCredential ? [{
+        name: "goat",
+        config: {
+          type: "remote",
+          url: "http://fixture.invalid/mcp",
+          headers: { Authorization: "Bearer scoped-goat-token" },
+          oauth: false,
+        },
+      }] : []);
+    }).pipe(
+      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
+      Effect.scoped,
+    ),
+  );
+
   it.effect.each(["completed", "failed", "unresolved", "unavailable", "reconnect"] as const)(
     "normalizes OpenCode step usage for %s turns",
     (ending) =>
```

## 6. Exact verification commands (parent execution only)

All test/typecheck/lint commands below: NOT RUN by this leaf because the task explicitly forbids builds/tests/installs. Exit status: unavailable. Direct file arguments exist in the inspected source. Package tsconfig.json files exist and include `src` (effect-acp also includes `test`; apps/server also includes vite.config.ts/scripts/integration). The server uses its own test configuration and relative git setup. Config-less provider/shared packages explicitly select root vite.config.ts with `--dir .`, matching their package.json test recipes; its environment is node and its excludes do not exclude these files. Typecheck may follow imported workspace dependencies; commands target these affected packages, not the repository recursively. `vp check`, `vp run -r test`, and `vp run -r typecheck` are prohibited.

After wp3/wp6 integration, run each test block from its owning package with package-relative paths as in 020. Reset to the source root for targeted typechecks, lint and later stale-name gates:

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/provider-cursor
vp test run --config ../../vite.config.ts --dir . src/server/adapter.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/provider-muse
vp test run --config ../../vite.config.ts --dir . src/server/adapter.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/provider-core
vp test run --config ../../vite.config.ts --dir . src/server/runtimeInstructions.test.ts src/server/mcpToolPresentation.test.ts
vp test run --config ../../vite.config.ts --dir . src/server/orchestrationInstructions.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/provider-acp
vp test run --config ../../vite.config.ts --dir . src/server/runtimeModel.test.ts src/server/mcpOverAcpBridge.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/provider-pi
vp test run --config ../../vite.config.ts --dir . src/server/mcpExtensionSource.test.ts src/server/mcpInjection.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared
vp test run --config ../../vite.config.ts --dir . src/t3McpToolPresentation.test.ts src/htmlRender.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/provider-opencode
vp test run --config ../../vite.config.ts --dir . src/server/adapter.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server
vp test run src/provider/CodexDeveloperInstructions.test.ts src/provider/acp/AcpJsonRpcConnection.test.ts src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts src/orchestration-v2/Adapters/CodexAdapterV2.test.ts src/orchestration-v2/Adapters/AcpAdapterV2.test.ts src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts src/orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts
vp test run src/orchestration-v2/testkit/OrchestratorReplayFixtures.contract.test.ts
vp test run src/orchestration-v2/testkit/OrchestratorReplayFixtures.integration.test.ts -t 'runs .*/(pi|muse|grok|opencode2) through OrchestratorV2'
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
vp exec tsc -p packages/shared/tsconfig.json --noEmit
vp exec tsc -p packages/contracts/tsconfig.json --noEmit
vp exec tsc -p packages/provider-core/tsconfig.json --noEmit
vp exec tsc -p packages/provider-acp/tsconfig.json --noEmit
vp exec tsc -p packages/provider-cursor/tsconfig.json --noEmit
vp exec tsc -p packages/provider-muse/tsconfig.json --noEmit
vp exec tsc -p packages/provider-opencode/tsconfig.json --noEmit
vp exec tsc -p packages/provider-pi/tsconfig.json --noEmit
vp exec tsc -p packages/effect-acp/tsconfig.json --noEmit
vp exec tsc -p apps/server/tsconfig.json --noEmit
vp lint packages/provider-opencode/src/server/adapter.test.ts \
  apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts \
  packages/provider-cursor/src/server/adapter.ts \
  packages/provider-cursor/src/server/adapter.test.ts \
  packages/provider-muse/src/server/adapter.ts \
  packages/provider-muse/src/server/adapter.test.ts \
  packages/provider-opencode/src/server/adapter.ts \
  packages/provider-acp/src/server/mcpOverAcpBridge.ts \
  apps/server/src/provider/CodexDeveloperInstructions.ts \
  apps/server/src/provider/CodexDeveloperInstructions.test.ts \
  packages/provider-core/src/server/runtimeInstructions.ts \
  packages/provider-core/src/server/runtimeInstructions.test.ts \
  packages/provider-core/src/server/orchestrationInstructions.ts \
  apps/server/src/cli/acpMcpBridge.ts \
  apps/server/src/mcp/McpSessionRegistry.ts \
  packages/contracts/src/settings.ts \
  packages/contracts/src/previewAutomation.ts \
  apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts \
  apps/server/src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts \
  packages/provider-acp/src/server/adapter.ts \
  packages/provider-acp/src/server/runtimeModel.ts \
  packages/provider-acp/src/server/runtimeModel.test.ts \
  packages/provider-acp/src/server/mcpOverAcpBridge.test.ts \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts \
  apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts \
  apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts \
  packages/provider-opencode/src/server/v2/adapter.ts \
  apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts \
  apps/server/src/orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts \
  packages/provider-pi/src/server/mcpExtensionSource.ts \
  packages/provider-pi/src/server/mcpExtensionSource.test.ts \
  packages/provider-pi/src/server/mcpInjection.test.ts \
  packages/shared/src/t3McpToolPresentation.ts \
  packages/shared/src/t3McpToolPresentation.test.ts \
  packages/shared/src/htmlRender.test.ts \
  packages/provider-core/src/server/mcpToolPresentation.test.ts \
  apps/server/src/mcp/McpHttpServer.ts
```

The replay `-t` filter observes exactly the affected four provider families; the source test title is `runs %s/%s through OrchestratorV2 using deterministic replay`. It is an affected fixture gate, not a substitute broad local suite. If test collection skips/matches zero relevant cases, record NOT OBSERVED and correct the filter; do not report a green command alone as coverage. Other unchanged provider scenarios are owned by CI. OpenCode 1 now exercises the actual `openSession` boundary with managed/external/credential-absent cases and exact `mcp.add` output. Its test helper adds an explicit `external` option, defaulting to the original external behavior for every existing test. An additional live external-server check is not authorized here.

Stale-name gates below are read-only and exact. Expected-empty searches use rg exit 1 as success, exit 0 as stale-name failure, and exit >=2 as tool error. Do not use `|| true` to hide an error. Each invocation must exit 0; stop on the first nonzero result. The function distinguishes an empty match from stale output and tool errors:

```sh
expect_empty() {
  if rg "$@"; then
    return 1
  else
    result=$?
    [ "$result" -eq 1 ]
  fi
}
expect_empty -n 'mcp__t3[-_]code__|"t3-code":|server: "t3-code"|name: "t3-code"' \
  apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts \
  packages/provider-cursor/src/server/adapter.ts \
  packages/provider-muse/src/server/adapter.ts \
  packages/provider-opencode/src/server/adapter.ts \
  packages/provider-pi/src/server/mcpExtensionSource.ts
expect_empty -n '"t3-code"' packages/provider-acp/src/server/mcpOverAcpBridge.ts
expect_empty -n '^\s*name: "t3-code"|serverId: "t3-code"' packages/provider-acp/src/server/adapter.ts
expect_empty -n 't3-code|t3\[-_ \]\?code|mcp__t3[-_]code__|server: "t3-code"' packages/provider-acp/src/server/runtimeModel.ts
expect_empty -n 't3-code|mcp__t3_code__' \
  packages/provider-core/src/server/orchestrationInstructions.ts \
  packages/provider-core/src/server/runtimeInstructions.ts \
  apps/server/src/provider/CodexDeveloperInstructions.ts
expect_empty -n '"t3-code":|mcp_servers\.t3-code|t3-code MCP unavailable|When the t3-code MCP|"key": ?"t3-code"' \
  apps/server/src/orchestration-v2/testkit/fixtures --glob '*_transcript.ndjson'
```

Expected allowed output, inspect exact lines rather than requiring a blanket empty `rg t3-code`:

```sh
rg -n 't3-code|t3\[-_ \]\?code|mcp__t3_code__' \
  packages/provider-opencode/src/server/v2/adapter.ts \
  packages/provider-acp/src/server/adapter.ts \
  packages/shared/src/t3McpToolPresentation.ts \
  docs/orchestration-v2/orchestrator-mcp-server.md \
  docs/internals/providers.md
```

Allowed: OpenCode old-namespace deny row only; ACP `clientInfo: { name: "t3-code", version: "0.0.0" }` only; shared read aliases/regex alternatives/comments and unchanged t3-code logo/icon types/defaults/result; docs' explicit legacy history/loadout and legacy deny explanation only. New registration examples must say goat. For Pi, no `mcp__t3_code__` alias or hidden exposure may remain in the generated registration path. The only remaining old prefix in the new Pi test should be none; old-prefix materialization string tests were removed.

The broad audit identifies excluded identities and preserved compatibility fixtures:

```sh
rg -n 't3-code|mcp__t3_code__' packages apps/server docs \
  --glob '!**/node_modules/**' --glob '!*.ndjson' --max-columns 220 --max-columns-preview
```

Allowed groups: shared/client-runtime/history/asset/projection fixtures; t3-code logo/icon ids; mobile palette; `t3-codex-*` temporary-directory names; clientInfo auth/probe/setup/text helper names in ACP/Grok/Antigravity/effect-acp; MCP Apps hostInfo; relay audience/tunnel/observability identities; upstream installer/store links. None are active GOAT MCP registrations. Do not globally replace these. Inspect every unexpected residual active-registration hit and amend the map before implementation.

Fixture JSON syntax gate (parent runs after applying, no source writes):

```sh
python3 - <<'PY_FIXTURE'
from pathlib import Path
import json
root = Path('apps/server/src/orchestration-v2/testkit/fixtures')
for file in root.rglob('*_transcript.ndjson'):
    for line in file.read_text().splitlines():
        if line.strip():
            json.loads(line)
print('all provider transcript records decode')
PY_FIXTURE
```

This syntax check observes changed NDJSON paths but cannot prove behavior. Replay is the behavioral gate. Parent records command, exit code, observed tests and integrated source revision. No runtime PASS or hosted CI claim is made by this plan.

## 7. Risks, rollback and remaining judgments

- Pi duplicate-name risk is resolved by deleting the inner alias loop and checking actual registration attempts before mock deduplication. Re-registering once on exposure changes remains intentional. Old saved loadouts/selectors will need their owner's edit; report this as a cutover compatibility limitation rather than a silent migration.
- ACP relaxed separators must stay gated by known tool ids; all origin checks change atomically with regexes. Preserve foreign metadata precedence and generic foreign MCP projection. D5's known-tool inventory update must land before `goat_thread_send` recovery tests run.
- OpenCode reused daemons retain old directory registrations. Denying both namespaces before own-thread allow prevents broad full-access grants from reopening old names. Removal addresses only the newly owned goat registration; no unsolicited deletion/restart of old shared daemon state. A provider choosing an old name receives a denial and needs a fresh session/user-managed reload.
- Claude namespace and bare-name mismatch can deny legitimate reads or accidentally widen read-only access. Annotation cross-check is mandatory after wp3; wildcard remains confined to non-read-only policy. Keep auth token indirection, timeout and log redaction unchanged.
- Shared resolver changes must keep old history and HTML attachments readable. Namespace recognition does not execute aliases; unknown/foreign tool ids stay generic. Logo/icon identifiers remain unchanged.
- Fixture edits only adapt the product-owned strings and permission namespace. They are not measured native harness captures. Focused replay plus independent review is required; native CLI normalization behavior is an unmeasured runtime integration risk until separately authorized/verified.
- Earlier-phase overlapping hunks (Claude tools, instructions, shared reader and docs) were refreshed against wp3 at `f08a410af`. Revalidate if HEAD or mapped source changes before B. Do not apply an original-baseline patch over earlier phases.

Rollback: parent reverts only wp6 adapter keys/namespace parsing/rules/Pi registration/instruction/doc/fixture deltas as one coherent slice. Preserve wp2 release acquisition and wp3 `goat_*` bare tools/shared bare-tool aliases. If rollback occurs after later wp4 work, preserve its executable/archive changes too. Restore previous legacy deny rules with the matching registration namespace; never leave a goat registration with a t3-only allowlist or vice versa. Leave database history, live installs and runtime processes untouched. If the parent creates a distinct wp6 commit, a parent-controlled revert is simplest; this leaf performs no git operation. Old active sessions still require owner-managed reload to adopt either direction.

Recommended `000_plan.md` D6 amendment: define a fresh-session cutover to goat only, with read-side legacy aliases; Pi public/normalized names coincide and therefore get one registration (old saved loadouts are a stated limitation); OpenCode denies retired t3-code directory entries as well as goat entries; Claude read-only ids combine D5 and D6. Replace “36 extra files” with the enumerated file map/actual count, including fixture adaptations and shared reader companions. Use the accepted A12 order wp2 → wp3 → wp6 → wp4 → wp5: wp6 runs after wp3 and before wp4, and wp5 probes final `mcp__goat__goat_*` names.

Plan map totals: 83 MODIFY files (42 replay NDJSON files); 0 NEW, 0 DELETE. Exact diffs refreshed from inspected `f08a410af` before-images; no source edits or backend verifier execution occurred in this delegation.

Artifact validation @f08a410af: all 83 diff blocks / 182 hunks were decoded in memory; every context/removal line matched the read-only source at its refreshed hunk position, both old/new hunk line counts and cumulative new-file offsets matched, and all 42 planned NDJSON after-images parsed as JSON. Eleven original hunks were amended: eight stale-content hunks (orchestrationInstructions ×2, runtimeModel test ×1, Claude allowlist ×1, Codex tests ×3, shared resolver ×1) and three line-position hunks (shared resolver comment ×1, shared presentation tests ×2). Docs before-images already match wp3 and require no stale amendment. The 19 Claude allowlist after-image ids match current read-only toolkit annotations by source inspection; the annotation test remains NOT RUN. All 11 test commands are package-directory recipes confirmed against package.json, with existing package-relative file arguments. No patch was applied; no source test/build/typecheck/lint or backend verifier was run.

## Audit fold 2 (cycle 3)

Readable OpenCode server names keep the baseline 56-character id ceiling in addition to the lossy-sanitization guard (hunk above). Add regression: owner id = "thread_" + 49×"x" (56 chars) stays readable; child id = owner + "_b" (58 chars) is digested, so the owner's `goat-<owner>_*` allow rule does not match the child's tools (assert via the permission evaluation used by the adapter tests, not only the rule array). Wildcard overlap for ids ≤ 56 remains the pre-existing residual.
