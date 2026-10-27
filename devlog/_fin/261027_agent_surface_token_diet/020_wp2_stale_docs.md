# wp2: stale agent-surface docs

Owner lane: sol worker W-DOCS. Each item was found by the R3 lane and must be re-verified.

- MODIFY `scripts/agent-surface/inventory.ts`: also read nested toolkit files that
  `McpHttpServer.ts` imports (`fleet/resources/tools.ts`, `fleet/healthTools.ts`), and judge
  "mounted" from those imports, so screen and storage stop showing as unmounted.
- MODIFY `scripts/agent-surface/audit.ts`: drop findings that shipped (`goat_describe` arguments,
  `goat call` and generated commands) and the false `goat thread read` check.
- REGENERATE `docs/internals/agent-surface-audit.md`; `audit.ts --check` exits 0.
- MODIFY `docs/internals/agent-surface.md`: tool counts (191 is stale; the catalog test expects
  213), the full-listing naming sentence, Proposed sections already restated as Now, rollout rows
  backed by merged PRs, and provider-owned deferral in Discovery.
- MODIFY `docs/operations/agent-surface-eval.md`: remove the "setting not on dev" limit.
- MODIFY `docs/orchestration-v2/orchestrator-mcp-server.md`: replace field lists that duplicate
  schemas with a `goat_describe` pointer, keeping lifecycle and policy.
- ADR-0007: follow the structure/ convention for superseded impact, or leave it.

Proof: `node scripts/agent-surface/audit.ts --check`, `vp fmt --check` on changed files, and a
source read-back of every changed claim.
