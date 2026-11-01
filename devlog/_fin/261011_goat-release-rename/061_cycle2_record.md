# 061 — Cycle 2 record (closes goalplan wp2; implements 020 = wp3 content)

## Conclusion

Commit `f08a410af`: 42 MCP tools renamed t3_* → goat__, server name GOAT, legacy presentation aliases (display/identity only), Claude read-only approvals on new names, SSH dispatch remote calls on goat__, docs/tests. Saved handoff coverage is refreshed to goat_thread_read at delivery. Mixed-version remote (t3_* only) fails with tool+host named.

## Evidence

Receipt: mobile 88, provider-acp 59, provider-core 6, shared 79, server 507, client-runtime 117, web 240, ssh 69 tests; tsc 9 packages. Review gpt-6.1-sol 01a127d0: FAIL (persisted handoff coverage) → NEAR-PASS.

## Pessimist notes

- Not improved: provider key still t3-code (qualified ids mcp__t3-code__goat_*), fixed in next cycle (050).
- Died: "a pure rename is mechanical" — persisted app-generated instructions needed a delivery-time rewrite.
- Refuting evidence would be: provider sessions that cached t3_* approvals failing after upgrade (check in wp5 with fresh sessions).

## Next

Cycle 3: closes goalplan wp3, implements 050 (provider key t3-code → goat); stale-check 050 at f08a410af.
