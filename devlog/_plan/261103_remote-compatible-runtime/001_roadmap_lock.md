# 001 Roadmap lock (wp0 D input)

Audited by terra reviewer Bacon (01a19e98-6dfc-7a13-8379-9d5630aafe4d): round 1 FAIL, round 2 FAIL, round 3 NEAR-PASS; residual folded (A3).

Locked decisions for wp1 (010 + A1-A3 are authoritative, in that order):
1. Admission rule: `blocked && compatibleLive` → ready/providers_not_ready + detail; any other blocked → update_blocked (unchanged text).
2. publishResult: selectedRuntime.updateBlocked → ready + detail (producers only set it on protocol-compatible selections).
3. Detail helper `compatibleRuntimeUpdateBlocked(host, live, requested, order)` in remoteRuntime.ts:
   order < 0 → "update GOAT on host or stop it there" recovery; order undefined → neutral, no update suggested;
   order === 0 or order > 0 → no updateBlocked/detail at all.
4. Pending-drain / uncertain-drain overrides and their tests stay unchanged.
5. Client: sshRuntimeRecoveryText shows detail for ready and providers_not_ready (when no refreshDeferred).
6. Web: pure `sshRuntimeUpdateOutcome` (new module + test) decides Update Everything terminal states; providers_not_ready never loops.
7. Agent surface text (contracts agentSurface/entries/ssh.ts:34) mentions that ready may carry a detail on why its runtime cannot be updated.
8. Failing-first evidence recorded for runtime-status rows, Windows launch, and readyEnvironment.

wp2 stays read-only; its cause is unproven until mini's desktop update state is read (mini idle at 23:30Z, still .314).

