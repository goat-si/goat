# L02 retry: provider adapter fixes (lane record)

Lane branch: `chase/t3-261114-adapters-retry`. Earlier runs' pushed heads (up to `0c89523f1d`) were never opened as a PR; this file is the lane's full record. Upstream range fa2f4ff2a2..93cbca3fcbd. Deferrals are tracked in #3176.

## Decisions

| upstream | decision | GOAT commit | reason |
| --- | --- | --- | --- |
| 2248ca8db9 fix(cursor): steer the live run | adapt | 0c89523f1d | GOAT's Cursor adapter keeps the live run; a declined steer queues right after the active run with the user's model. Needed upstream's Kiro capability flag so a steer with attachments still restarts. Code moved out first (c0d2082486, de2ff5d7b3, 7e6936778a, a462be1344). |
| 315b06c5ec managed installs update past their pin | adapt (Codex half) | 288d66a681 | Owner decision 2026-11-15. SHA-256 from the release's codex-package_SHA256SUMS verified before install, download capped at 1 GiB; pinned release keeps its exact-size check and stays the fallback. Moves first: 3b58c0548f, 028f0c0a56. |
| 315b06c5ec Antigravity registry path | skip | none | Never ported: it installs an archive without a digest GOAT verifies (AntigravityInstallation.ts:629); 4099e62767 replaced it upstream. |
| b5b470542a Codex Stop that Codex never confirms | adapt, held | 4bedf48e18 (local branch chase/t3-261114-l02-hold-b5b, not pushed) | Coordinator Option 2. Held because the agent-facing check met the STOP rule: an unconfirmed Stop leaves the child "running" in thread.status with no visible reason and only a person's Force stop clears it (goat#2338). Waiting for the coordinator. |
| ee9e36c8b2 feat(secrets): check a secret reference before saving it | not done this round | none | Adapt to GOAT's own secret resolver (apps/server/src/secrets/secretResolver.ts:62, ProviderInstanceRegistry.ts:179) and SecretReferencePicker; new RPC is C4. |
| 4099e62767 Antigravity native goals | adapt (native goals part) | 8a1c2870e1 | Sessions that list a "goal" command report native goals; the ACP adapter reads it after startup commands drain; Antigravity goal controls other than "/goal <objective>" are refused before any event. GOAT's hasNativeGoals generalised (providerTurnStartHelpers.ts:28). Moves first: 4d5775de74, d4cc03e826. pair.test.ts not carried (an unrelated Tailscale serve test rewrite). |
| 4099e62767 Antigravity managed CLI updates | owner-approved, not yet ported | none | Upstream's final installer is 1177 lines (test 1321) and replaces GOAT's AntigravityInstallation.ts (966) with the manifest SHA-512 path, host allow-list, refused redirects and bounded download and extraction; it needs splitting into new modules to stay under 1000 lines. Its new CLI arguments (antigravityAuthSupport.ts, AntigravityDriver.test.ts:388) and system-prompt metadata (AntigravityAcpSupport.ts) go with it, since they need the CLI range >=1.5.1 <2. |
| b42841808d | deferred | none | Needs predecessors 729f6757d9 and 5ff3d3c0ec, not on dev. |

## C4

- 315b06c5ec Codex half (install verification). Negative tests in apps/server/src/provider/CodexInstallation.update.test.ts: published checksum mismatch keeps the managed install (:67); unreachable checksums offer no update and download nothing (:83); a release the manifest withdrew is refused before and during install (:111, :198); a withdrawn managed install returns to the pinned release (:151). No wire contract changes: `ProviderInstallState` fields are unchanged, so older peers see a version offer the same way they see the pinned one.

## When a Codex update happens and what the user sees

GOAT looks for a newer Codex at most hourly, and only while a client watches Codex setup with provider update checks on. It offers a release only when the model manifest marks it supported. Settings → Providers → Codex then shows "Update Codex" with the new version; nothing installs until the user presses it. A fresh install still gets the pinned release; an existing install is never downgraded. docs/user/install.md says this.

## Known limits

- No MCP Force stop exists (goat#2338); relevant once b5b470542a lands.
- The Antigravity managed install stays on its pin until 4099e62767's updater is ported.

## Surfaces

Server: Codex installer, Cursor steering, Antigravity native goals (orchestrator refusal, goal-driver check), provider registry moves. Web: Codex setup shows "Update Codex" when a newer verified release is offered (CodexSetupSection.tsx). Desktop: same as web. Mobile: no change. Agents/MCP: an agent sending "/goal pause" (or clear, resume, edit, bare /goal) to an Antigravity thread gets the dispatch refusal message. Providers: Codex, Cursor, Antigravity (ACP adapter capability read).

## Dev merges

- 87dbaa401a merges origin/chase/t3-261114-all (56421003ff). Conflicts: CodexProvider.ts (kept the catch-up branch's per-provider probe timeout and the lane's native-usage destructuring), ProviderRegistry.ts (took the catch-up branch's move to ProviderModelRetention.ts and carried the lane's Cursor retention rule there), contracts orchestrationV2.ts (kept both capability fields). Budget moves after the merge: 69822712dd, e3970030d2, ef9cd1233f.

## Tests

- 4099e62767 native goals fail-first: on dev code the five "refuses unsupported Antigravity goal controls" rows and the hasNativeGoals row fail, and both "negotiates native goals" rows hang to the 240 s test timeout (capabilities are read before the startup commands drain); all pass after the port.
- Codex half fail-first: the update tests do not compile or pass against dev's installer (no checkForUpdate, no SHA256SUMS lookup); after the port, CodexInstallation tests 80 pass.
- b5b470542a fail-first (held commit): all six new or rewritten tests fail on dev's adapter; removing the survivor pass-through fails 3 rows plus H2; replacing a pending waiter fails the second-Stop row.

- check:changed on 8a1c2870e1: same as below with test 1505 files: 3 failed (the same three), 1494 passed, 8 skipped (23276 tests passed).
- check:changed on ef9cd1233f (merged with chase/t3-261114-all 56421003ff): unused patches, format, lint, knip 1/2 and 2/2, graphql (2), agent surface audit, agent context budget, typecheck (42 packages) pass; test 1502 files: 3 failed, 1491 passed, 8 skipped (23266 tests passed). The three failures are outside the lane, which has no diff from chase/t3-261114-all in those paths, and they fail the same way alone: packages/ssh runtimeFactsScripts.test.ts and tunnel.client-session.test.ts ("Remote host is missing node on PATH": this Mac's non-interactive shell has no node), apps/server notes/NotesGit.test.ts (attachment commit order under the local git).
- goat-rename --check: 0.

NOT RUN: ee9e36c8b2 port; the 4099e62767 Antigravity updater; captures of the Codex "Update Codex" offer; real Codex, Cursor or Antigravity turns; native-client checks.

Model: anthropic/claude-opus-5-5 via Codex in GOAT on pen-macmini, coordinated by anthropic/claude-opus-5-5
