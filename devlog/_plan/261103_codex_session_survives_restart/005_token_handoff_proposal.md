# 005 — Proposal (NOT in this PR): hand GOAT MCP credentials across a restart

Status: proposal for the parent/user; orchestrator decision D3 keeps it out of this PR.

## Problem
A Codex turn adopted after restart keeps the Authorization header minted by the previous server run
(CodexAdapterV2.ts:1420-1425). The new run refuses it as earlier_server (McpSessionRegistry.ts:62-72), so goat_* tools fail until the
thread's next quiet turn reloads fresh credentials. Orchestration-heavy threads lose most of their usefulness for the rest of that turn.

## Proposal
At shutdown, only for threads whose Codex process is retained (030), write the credential record's SHA-256(token) plus
{threadId, providerInstanceId, providerSessionId, grantedScopes, memory grant, policyEpoch, issuedRunTag, expiresAt} into
<stateDir>/codex-app-servers/<instance>.credentials.json (0600, dir 0700, atomic rename). The next run loads it once at startup into
McpSessionRegistry as "inherited" entries: resolve(token) hashes the presented token and honors an inherited entry only for its thread,
only with authority recomputed from current settings (never widened), and only until (a) that thread's next reload installs a fresh
credential, (b) the adopted turn ends, or (c) expiresAt (e.g. 6 h). The file is deleted after load; inherited entries never survive a
second restart.

## Threat model
- Disclosure of the file: hashes of 256-bit random secrets; offline inversion infeasible. Equivalent to API-token-hash storage.
  The file sits beside statev2.sqlite, which already holds more sensitive state under the same user.
- Replay by a local attacker with the token itself: same exposure as today during a server run (the token is in Codex's process env /
  config and process memory). The handoff extends the token's life across one restart, bounded by (a)-(c).
- Authority drift: authority is recomputed at load; revocations and setting changes made while GOAT was down apply. A deleted/archived
  thread gets nothing.
- Cross-environment: file is per GOAT state dir; pid/instance mismatch or unknown thread -> ignored.
- Invariant change: today "a server restart invalidates every MCP token". After: "a restart invalidates every MCP token except those of
  turns GOAT deliberately kept running, until those turns end." This is the decision the user must make.

## Cost
~150 lines in McpSessionRegistry + record writer, tests for: inherited token honored for its thread only, refused after reload/expiry,
refused on second restart, authority narrowed by changed settings.

