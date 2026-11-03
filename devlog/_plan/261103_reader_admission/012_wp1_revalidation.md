# 012 — wp1 P revalidation

- Previous D (wp0): "roadmap locked … Next: wp1 P re-verifies 010/011 against dev, then dispatches the terra implementer with 011." This P continues in that direction without changes.
- Stale check: origin/dev 21c65d8620 → 55a3236c86. `git diff --stat 21c65d8620 origin/dev -- packages/shared/src apps/server/src/orchestration-v2/readerOverloadFallback.ts apps/server/src/orchestration-v2/ProviderEventIngestor.readerOverload.test.ts oxlint-plugin-goat/code-budgets.json` returns nothing, so every path:line in 010/011 holds. The branch stays on 21c65d8620 (AGENTS.md: do not rebase because dev moved).
- Executable plan for wp1 = 011_wp1_packet.md (consolidates 010 + R2–R4). Verifiers: as listed in 011 PROOF (b); `vp run check:changed` by the coordinator.
- Dispatch: implementer = new terra subagent (gpt-6.1-terra, high), write role (worker), shared worktree (only one writer; the reviewer is read-only), packet 011 verbatim.

