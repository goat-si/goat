# 000 Plan — compatible, unreplaceable SSH runtimes stay connected; Windows auto-update cause

Base: origin/dev 81691e1ced (branch fix/remote-compatible-runtime-not-blocked).
Worktree: /Users/jun/.goat/desktop-nightly/worktrees/goat/fix-remote-compatible-r-baa0f23d23039b14

## Incident (2026-11-03 ~08:30 KST)
- Mac desktop updated to 0.1.2-nightly.20261102.317 (server start 23:12:23Z).
- ssh.host_status mini: state update_blocked, runtimeVersion .314, requestedVersion .317,
  detail "A GOAT server that this app didn't start or cannot replace is running on mini. Stop it on the host, then reconnect."
- host.status mini: unreachable from 23:13:31Z (342 failed contacts), Lost 7 min later. mini itself is up (tailscale, ping 6 ms, SSH 22).
- mini (Windows) runs .314 started by its own desktop app.

## Root cause
1. `liveRuntimeBlocksUpdate` (packages/ssh/src/remoteRuntime.ts:181-189) is true for a compatible live runtime this app
   does not own, cannot order, or cannot drain. That answer is right for *updating*.
2. Two publishers turn it into the *connection* state `update_blocked`:
   - status read: packages/ssh/src/tunnel.ts:4269-4300 (`state: blocked ? "update_blocked" : ...`).
   - launch publish: packages/ssh/src/tunnel.ts:2532-2533 (`selectedRuntime.updateBlocked` → `update_blocked`).
3. Every reader that waits for ready refuses: `requireReadyEntry` packages/ssh/src/tunnel.ts:4497-4512
   (readyEnvironment, MCP requireReady sessions, Connections page) and `invalidateReconnectSelection` at 4485-4493.
   So the Mac's attached forward to mini is unusable even though the protocols match.
4. History: git history is squashed (b59034d2b30 "Initial commit" 2026-11-01). PR #990 (merged 2026-10-23,
   "older apps connect to newer hosts that speak their protocols") fixed the *newer* compatible case with the same
   rule and explicitly left "Older or unowned runtimes behave as before". PR #683 introduced adoption of GOAT's own
   unrecorded runtime and kept foreign ones "attach-only". The `PreparedRemoteRuntime.updateBlocked` doc
   (remoteRuntime.ts:117) already says "Why a compatible live selection can be attached to, but cannot be updated."
   The safety intent is "never replace/downgrade a runtime this app does not own" (docs/internals/remote-updates.md:40, 308),
   not "refuse to use it". Blocking the connection contradicts remote-updates.md principle 1 and 4 and the verdict table
   ("compatible → Normal use. An eligible newer server or app shows as an optional update.").
5. Native Windows: packages/ssh/src/runtimeWindows.ts:274 sets updateBlocked for every version mismatch after the
   protocol check at 255-266 passed → same 2532 path → not ready.

## Invariant relied on
`updateBlocked` is only ever set on a protocol-compatible selection:
- runtimeProvisioning.ts:655 selectedVersion is the live version only when liveCompatible (live) or retained (liveStatus none);
- runtimeProvisioning.ts:657/708 fallbackToLive requires liveCompatible; upgradeRetained needs liveStatus none;
- runtimeProvisioning.ts:893/910 published path requires after.liveStatus none;
- runtimeWindows.ts:255-266 fails before 274 unless binary and live signals match.
So publishing ready for updateBlocked never admits an incompatible runtime.

## Work-phase map (dependency order)
- wp0 (this cycle): docs-only roadmap. No production patch.
- wp1 (010): compatible-unreplaceable → ready + detail; incompatible stays update_blocked. Failing-first tests. PR → exact-head CI → terra review → merge-pr.ts.
- wp2 (020): Windows desktop auto-update flow analysis (read-only) + mini checklist; live check on mini only through GOAT paths after wp1 ships.

## Constraints
No release/nightly trigger, no app restart, no real DB writes, no stopping servers on remote hosts, no terminal ssh,
no pattern kill, no repo-wide checks. Deterministic tests only (TestClock/Deferred, no sleeps).
Follow docs/internals/server-resilience.md (no new emitters here). Plans stay uncommitted (devlog/_plan is in .git/info/exclude).

