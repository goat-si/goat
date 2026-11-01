# 062 — Cycle 3 record (closes goalplan wp3; implements 050 = wp6 content)

## Conclusion

Commit `cd1dfd752`: provider MCP registration key t3-code → goat in every adapter; Claude allowlist mcp__goat__goat__; legacy namespaces read-side only; OpenCode legacy t3-code-_ deny kept; OpenCode names digest when lossy or id > 56 (no new collisions, no widened wildcard); ACP identity recovery tries each convention (goat_ prefix ambiguity).

## Evidence

Receipt: cursor 13, muse 23, provider-core 25, acp 66, pi 20, shared 105, opencode 51, ssh 69, server 678, replay 2+29; tsc 10 packages. Audit 01a127d9: FAIL→FAIL→NEAR-PASS. Review 01a127e5: FAIL→PASS.

## Pessimist notes

- Not improved: pre-existing OpenCode own-thread wildcard overlap for readable ids ≤ 56 (residual, follow-up).
- Died: "registration key rename is mechanical" — it created a prefix ambiguity in ACP recovery and a naming collision in OpenCode.
- Refuting evidence: a provider that caches approvals by qualified id rejecting mcp__goat__* after upgrade (check in wp5 with fresh sessions).

## Next

Cycle 4: closes goalplan wp6, implements 030 (CLI goat executable + remote ~/.goat root); re-stale-check 030 at cd1dfd752.
