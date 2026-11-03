# 010 wp1 — a compatible runtime this app cannot update keeps serving it

Class: C3 (cross-module: packages/ssh status + client-runtime text + web update flow; no contract schema change).

## Behavior
| live runtime vs this app | before | after |
|---|---|---|
| compatible, unowned (other app/desktop started it), older | update_blocked, not usable | ready (or providers_not_ready), detail says why it cannot be updated and what to do on the host |
| compatible, owned, unknown order (dev build) | update_blocked | ready + detail (existing ready recovery for unknown order still applies when no detail) |
| compatible, owned, older, cannot drain, not requested | update_blocked | ready + detail |
| native Windows compatible, version != requested | update_blocked after launch | ready + detail |
| newer compatible | ready (PR #990) | unchanged |
| newer incompatible / runtime-newer launch error | update_blocked "runs a newer GOAT" | unchanged |
| older incompatible unowned | update_blocked "didn't start..." | unchanged |
| uncertain drain / unverifiable deferred drain | update_blocked | unchanged |

Never: drain, stop, upload over, or replace an unowned or newer runtime (unchanged; only the published state changes).

## Diffs

### MODIFY packages/ssh/src/remoteRuntime.ts (after liveRuntimeBlocksUpdate, ~line 190)
```ts
/** Why a compatible live runtime keeps serving this app while its update waits on the host. */
export const compatibleRuntimeUpdateBlocked = (
  host: string,
  liveVersion: string,
  requestedVersion: string,
) =>
  `${host} keeps running GOAT ${liveVersion}, which this app didn't start or cannot replace. To move it to ${requestedVersion}, update GOAT on ${host} or stop that server there when its work is done, then reconnect.`;
```

### MODIFY packages/ssh/src/tunnel.ts status read (~4286-4300)
before:
```ts
        snapshot = {
          ...base,
          runtimeVersion: probe.liveVersion,
          state: blocked
            ? "update_blocked"
            : providers?.ready === false ? "providers_not_ready" : "ready",
          ...(providers === undefined ? {} : { providers }),
          ...(blocked ? { detail: order !== undefined && order > 0 ? NEWER : UNOWNED } : {}),
        };
```
after:
```ts
        // A compatible runtime this app cannot update still serves it; only an incompatible one restricts the host.
        const restricted = blocked && !compatible;
        snapshot = {
          ...base,
          runtimeVersion: probe.liveVersion,
          state: restricted
            ? "update_blocked"
            : providers?.ready === false ? "providers_not_ready" : "ready",
          ...(providers === undefined ? {} : { providers }),
          ...(blocked
            ? {
                detail: !restricted
                  ? compatibleRuntimeUpdateBlocked(host, probe.liveVersion, requestedVersion)
                  : order !== undefined && order > 0 ? NEWER : UNOWNED,
              }
            : {}),
        };
```
(NEWER/UNOWNED = the two existing literal messages, unchanged.)

### MODIFY packages/ssh/src/tunnel.ts publishResult (~2532)
before: `snapshot = { ...base, state: "update_blocked", detail: result.selectedRuntime.updateBlocked };`
after:
```ts
      // updateBlocked is only set on a protocol-compatible selection, which serves this app.
      snapshot = { ...base, state: "ready", detail: result.selectedRuntime.updateBlocked };
```
The following providers enrichment (~2550) keeps `detail` via spread.

### MODIFY packages/ssh/src/runtimeProvisioning.ts (~410)
updateBlocked text → `compatibleRuntimeUpdateBlocked(target.alias, selectedVersion, version)`.

### MODIFY packages/ssh/src/runtimeWindows.ts (~274)
updateBlocked text → `compatibleRuntimeUpdateBlocked(target.alias, selected.version, version)` (keep the condition).

### MODIFY packages/client-runtime/src/state/sshRuntime.ts sshRuntimeRecoveryText
- `case "ready"`: after `if (deferredRecovery) return deferredRecovery;` add `if (status.detail) return status.detail;`.
- `case "providers_not_ready"`: join `[fixes[0]?.instruction, deferredRecovery ?? status.detail]`.

### MODIFY apps/web/src/components/sidebar/useUpdateEverything.ts (~116-124)
For `ready` with runtimeVersion !== requestedVersion, message = `status.detail ?? \`Still on ...\``.

## Tests (failing first on dev, in existing files)
1. packages/ssh/src/tunnel.runtime-status.test.ts:425-450 table: rows
   `{ version: "1.2.2", owned: false }` and `{ version: "1.2.3-dev.deadbeef", owned: true }` → expected "ready";
   assert detail includes "didn't start or cannot replace" for those rows. Add row: owned true, older, liveDrain false
   (not requested) → ready. Keep the incompatible-newer test (442-458). Add: older unowned with incompatible signals → update_blocked.
2. Launch-level: in the existing launch/pending-manager fixture, a compatible live runtime with liveOwned:false →
   ensureEnvironment succeeds AND readyEnvironment returns the entry (fails on dev with notReady), and no drain/stop/upload call happened.
3. Re-classify existing `update_blocked` expectations in tunnel.pending-manager.test.ts (662, 1724, 1778, 1851, 1862, 1904),
   tunnel.reconnect-probe-wake*.test.ts, tunnel.reconnect-probe-changes.test.ts:196-200: those with a compatible unowned/undrainable
   live runtime flip to ready+detail; uncertain-drain ones stay update_blocked. Each change states why in the PR.
4. packages/client-runtime/src/state/sshRuntime.test.ts: ready with detail → recovery text is the detail.

## Verification
- `vp test run` on each changed test file: red on dev for 1-2 (record), green after.
- `vp run check:changed` before push.
- PR to dev; exact-head goat-ci-result SUCCESS; terra review PASS; `node scripts/merge-pr.ts <pr>`.
- Docs: docs/internals/remote-updates.md:308 still true; check structure/ssh.md and docs/user for update_blocked wording.



## Amendment A1 (audit round 1, reviewer Bacon: FAIL → folded)
1. (P1) Status read admits ready only with `compatibleLive` (tunnel.ts:4270: live + binary signals, identity present), never bare `compatible`:
   ```ts
        // A runtime this app cannot update still serves it when its server and binary both speak this app's protocols.
        const servesUnmanaged = blocked && compatibleLive;
        state: blocked && !servesUnmanaged ? "update_blocked" : providers?.ready === false ? "providers_not_ready" : "ready",
        detail: blocked ? (servesUnmanaged ? compatibleRuntimeUpdateBlocked(...) : order>0 ? NEWER : UNOWNED) : none
   ```
   Tests: unowned older with compatible live signals but (a) missing liveBinarySignals, (b) binary serverVersion mismatch,
   (c) incompatible binary signals, (d) identityAbsent → stay update_blocked.
2. (P1) Pending/deferred-drain paths are unchanged: tunnel.ts:4359-4369 (`pending?.refreshCause === "drain_unavailable"` → update_blocked)
   and 4462 (uncertainDrain) still override. Assertions at tunnel.pending-manager.test.ts:662, 1724, 1778, 1851, 1862, 1904 and
   tunnel.reconnect-probe-wake.test.ts:186 stay as they are (no reclassification). tunnel.reconnect-probe-changes.test.ts:196 asserts
   selection metadata; unchanged. Only tunnel.runtime-status.test.ts:430-431 flip.
3. (P2) useUpdateEverything.ts: treat `providers_not_ready` like `ready` for the terminal decision (requested version → updated;
   otherwise failed with `status.detail ?? "Still on ..."`), so it never loops. Focused test only if an existing test file covers this hook.
   packages/contracts/src/agentSurface/entries/ssh.ts:34: add that ready may carry a detail explaining why its runtime cannot be updated.
4. (P2) Extra failing-first coverage: native Windows launch with compatible version mismatch → ready+detail and readyEnvironment
   succeeds (existing Windows test file); providers_not_ready keeps detail; reconnect after ready+detail reuses the attachment without upload.
5. (P2) Windows wording: runtimeWindows.ts sets updateBlocked only when `compareRuntimeBuilds(selected, requested)` is not > 0;
   a newer compatible Windows runtime publishes plain ready (client shows "Newer than this app"), matching PR #990.
   Helper text stays neutral: "${host} runs GOAT ${live}, which this app didn't start or cannot replace, so it keeps using it. To move ${host} to ${requested}, update GOAT on ${host}, or stop that server there when its work is done, then reconnect."



## Amendment A2 (audit round 2 → folded)
1. Positive rows (tunnel.runtime-status.test.ts:430-431 and the new older-owned-undrainable row) set
   `liveBinarySignals: signals(version)` alongside `liveSignals`; the negative rows (missing binary, mismatched binary serverVersion,
   incompatible binary protocol, identityAbsent) stay update_blocked.
2. Helper takes the build order:
   ```ts
   export const compatibleRuntimeUpdateBlocked = (host, liveVersion, requestedVersion, order: number | undefined) =>
     order !== undefined && order < 0
       ? `${host} keeps running GOAT ${liveVersion}, which this app didn't start or cannot replace. To move it to ${requestedVersion}, update GOAT on ${host} or stop that server there when its work is done, then reconnect.`
       : `${host} runs GOAT ${liveVersion}, which this app didn't start or cannot replace, so it keeps using it. GOAT can't tell whether it is older than ${requestedVersion}, so it suggests no update.`;
   ```
   Callers pass the order they already computed (tunnel.ts `order`, runtimeProvisioning.ts `liveOrder`/`compareRuntimeBuilds` for the
   selected version, runtimeWindows.ts `compareRuntimeBuilds({version: selected.version}, {version, commitTime: runner?.archiveCommitTime})`).
   Proven newer (order > 0): no updateBlocked at all (plain ready, client shows "Newer than this app").
   Tests: Windows unknown-order and older-order wording; status read unknown-order dev build wording.
3. Extract the Update Everything SSH terminal decision into a pure exported function
   `sshRuntimeUpdateOutcome(status: SshHostStatus | undefined): ServerUpdateOutcome | null` in a new module
   apps/web/src/components/sidebar/sshRuntimeUpdateOutcome.ts (null = keep waiting: update_waiting/preparing), used by
   useUpdateEverything.ts. New test sshRuntimeUpdateOutcome.test.ts: providers_not_ready at requested → updated; providers_not_ready
   or ready on older with detail → failed with that detail; update_blocked → failed; update_waiting → null (keeps waiting).


## Amendment A3 (audit round 3 NEAR-PASS → folded)
order === 0 (live runs the requested version): no updateBlocked/detail at all; plain ready, client shows "Up to date".
Test: unowned live at the requested version with binary signals → ready with no detail.

## Amendment A4 (B-phase finding, parent decision)
`identityAbsent` (runtimeProbe.ts:211-212) means *this client's* state dir has no launch identity record; it is expected for every
runtime this app does not own and proves nothing about the live server (runtimeProbe.ts:203 "The live descriptor proves identity").
Requiring it made the status read re-block a runtime the launch path had just admitted (tunnel.runtime-status.test.ts ownership-loss test).
Admission for the status read is therefore: live signals compatible AND liveBinarySignals present, serverVersion === liveVersion, and
matchesSignals(binary) — i.e. compatibleLive without the identity clause. Negative rows: missing/mismatched/incompatible binary stay
update_blocked; the identityAbsent row flips to ready. Existing `compatibleLive` (with identity) stays as is for the drain/archive deferral paths.
