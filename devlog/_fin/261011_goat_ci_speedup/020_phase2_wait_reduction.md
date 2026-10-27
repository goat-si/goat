# 020 wp2: remove avoidable real waits

## Stale check at wp2 P (tree 8ab853b20)

Locations after wp1: `nativeScripts` at `tunnel.fixture.ts:177`; byte test at
`tunnel.core.test.ts:52`; archive `runShell` at `tunnel.core.test.ts:1400` (env PATH/HOME,
`extendEnv: false`), `runRunner` at `:1435`; lock test at `:1612`. `nativeScripts` callers:
core 9, runner-switch 3, protocol-acquisition 3, protocol-identity 2 (the single-request wrapper keeps
them unchanged). Durations at wp1 (/tmp/goat-ci/wp1-c1.json, 10 files in parallel): byte test 6.59 s,
lock test 6.78 s (serial baseline 3.94 s / 6.47 s). Both live in tunnel.core.test.ts (95-117 s lane),
so the expected effect is on that file's lane and on CPU, not on the slowest lane (protocol-stop ~125 s).

Depends on wp1 (paths below are the split files). Production `tunnel.ts` is not modified in wp2
unless step 3 produces evidence; the default generated script bytes stay identical either way
(asserted by the existing baseline test, tunnel.test.ts:250-297 -> tunnel.core.test.ts).

## 1. Batch native script generation in the byte test (architect D4)

MODIFY `tunnel.fixture.ts`, `nativeScripts` (orig tunnel.test.ts:190-223):

```diff
-const nativeScripts = Effect.fn("test.nativeScripts")(function* (
-  input: SshTunnel.RemoteT3RunnerOptions,
-  selection?: SshTunnel.PreparedRemoteRuntime,
-) {
+type NativeScripts = { runner: string; launch: string; pairing: string; mcp: string; upload: string | null; probe: string };
+// One native Node process renders every request; Vite reformats Function.toString().
+export const nativeScriptsBatch = Effect.fn("test.nativeScriptsBatch")(function* (
+  requests: ReadonlyArray<{ input: SshTunnel.RemoteT3RunnerOptions; selection?: SshTunnel.PreparedRemoteRuntime }>,
+) {
   ...
-const input = ${JSON.stringify(input)};
-const selection = ${JSON.stringify(selection)};
-console.log(JSON.stringify({ runner: ..., upload: ... }));`;
+const requests = ${JSON.stringify(requests)};
+console.log(JSON.stringify(requests.map(({ input, selection }) => ({ runner: ..., upload: ... }))));`;
   ...
-  const scripts = JSON.parse(result.stdout) as {...};
-  for (const entry of [...]) assert.notMatch(scripts[entry], /@@T3_[A-Z_]+@@/);
-  return scripts;
+  const all = JSON.parse(result.stdout) as Array<NativeScripts>;
+  assert.equal(all.length, requests.length);
+  for (const scripts of all) for (const entry of [...]) assert.notMatch(scripts[entry], /@@T3_[A-Z_]+@@/);
+  return all;
 });
+export const nativeScripts = (input: SshTunnel.RemoteT3RunnerOptions, selection?: SshTunnel.PreparedRemoteRuntime) =>
+  nativeScriptsBatch([{ input, selection }]).pipe(Effect.map((all) => all[0]!));
```

The per-request body expression (runner/launch/pairing/mcp/probe/upload) is unchanged text.
`JSON.stringify(undefined)` for a missing selection becomes an absent property; the builder
receives `undefined` as before.

MODIFY `tunnel.core.test.ts` "preserves ordinary runner, launch and pairing script bytes": build
the 12 inputs (3 keys x 4 variants, orig :251-268) as one request list and call
`nativeScriptsBatch` once. Assertions run in the original order against `results[i]`. The two later
calls per archive key (orig :278 `.upload`, :285 `.runner` of `inputs[key]`) use the result of
the first variant of that key, which is the same input. Assertion count unchanged.

## 2. Stale-lock grace via a test-only `sleep` shim (architect D5, amended)

MODIFY `tunnel.core.test.ts`, "archive runner script" describe (orig 1595-1632):
`runShell` gains an optional PATH prefix; `runRunner` passes it through.
In "installs once when several launches race, and reclaims stale locks" (orig 1809-1855), only the
final unowned-lock run uses a temp `bin/sleep` script (`#!/bin/sh\nexec /bin/sleep 0.01\n`).
The script under test still emits `sleep 1`; the shim changes the wall duration of each poll
only, so the test still proves reclaim after five unowned observations. Concurrent-race runs keep
the real `sleep`. Expected saving: 4 x ~1 s (4 sleeps precede the 5th observation).
The shim appends one line to `bin/sleep-calls` per call (`echo x >> "$(dirname "$0")/sleep-calls"`)
and the test asserts exactly 4 calls, which proves the shim intercepted every poll. This assumes
`sleep` is external in the test shell (true for `sh` on macOS, bash, dash); a custom
`T3_SSH_TEST_SHELL` with a builtin `sleep` would fail the 4-call assertion loudly, not silently pass.
Setup (A fold 1): inside the owning test, using its scoped temp `root` and `fs`
(`tunnel.core.test.ts:1614-1617`), create `${root}/bin`, write `${root}/bin/sleep`, `fs.chmod(..., 0o700)`;
pass `${root}/bin` as PATH prefix only to the `afterUnowned` call (`:1650-1654`); `runShell` keeps its
third `bytes` argument and the concurrent calls (`:1626-1629`) keep the real PATH.

## 3. Measure stop/PID-exit loops on the critical lanes (architect D6)

Measurement without tracing and without repo edits: the protocol fixture passes
`PATH: process.env.PATH` to its remote shells (orig tunnel.test.ts:3551), so the test run is
started with `PATH=/tmp/goat-ci/sleeplog:$PATH`. `/tmp/goat-ci/sleeplog/sleep` (written, 6 lines)
appends `<epoch-s> <PPID> 0.1` to calls.log only for `sleep 0.1`, then `exec /bin/sleep "$@"`. Only the two PID-exit
loops call `sleep 0.1` (tunnel.ts:1150, 1340; check with `rg -n 'sleep 0\.1' packages/ssh/src/tunnel.ts`).
One extra fork+exec per 0.1 s sleep (a few ms) adds no meaningful time to a loop.

Metric (boundary-free): the time a run spends in these loops is at most
`calls x 0.1 s` plus a few ms each, and that is also the most any change to the loops could save.
Counting calls needs no per-invocation boundaries, so interleaving and repeated invocations in one
shell do not matter. Each file is run on its own (one file per command, so file parallelism cannot
mix lanes), with `calls.log` truncated before each run:
`tunnel.protocol-stop.test.ts`, `tunnel.protocol-acquisition.test.ts`, `tunnel.protocol-manager.test.ts`.
Coverage limit: the `shim=true` stop cases set the remote PATH to `/usr/bin:/bin`
(orig tunnel.test.ts:5142-5148, 5168-5188) and bypass the logger; they are reported as unmeasured,
and their share of the file's wall time is listed from the JSON report.
Decision rule: if `calls x 0.1 s` >= 10% of a measured file's wall time, plan a P amendment for
default-valued builder placeholders (stop/upgrade poll interval); otherwise record the numbers and
stop (no production change).

### D6 result (measured at wp2 P, tree 8ab853b20, files run one at a time with the sleep logger)

| File                                | wall alone | `sleep 0.1` calls | budget | share |
| ----------------------------------- | ---------: | ----------------: | -----: | ----: |
| tunnel.protocol-stop.test.ts        |       81 s |                 4 |  0.4 s |  0.5% |
| tunnel.protocol-acquisition.test.ts |       75 s |                 1 |  0.1 s |  0.1% |
| tunnel.protocol-manager.test.ts     |       67 s |                 3 |  0.3 s |  0.4% |

All three passed (exit 0). Decision: below the 10% trigger, so no production change and no P
amendment; wp2 implements sections 1 and 2 only. Unmeasured: the shim=true stop cases (remote PATH
/usr/bin:/bin), 15.078 s of 79.432 s (18.98%) of the stop file (A fold 2, from d6-protocol-stop.json).
Raw logs: /tmp/goat-ci/d6-_.calls, reports /tmp/goat-ci/d6-_.json.
Side observation: alone these files take 67-81 s, in the 10-file parallel run 105-125 s, so on the
12-core Mac the lanes contend for CPU; EPYC (192 threads) should show less inflation.

## wp2 C finding (2026-10-11, local runs stopped at user request)

wp2 check run /tmp/goat-ci/wp2-c1.json: 321/325 passed; byte test 0.74 s and lock test 3.03 s passed.
Failures: 4 x protocol-stop "old-entry Node server" (/bin/ps saw `/bin/sh <runner>` instead of node);
probe run also failed 2 x protocol-identity "checks an old Node entry" (server-runtime.json missing).
Cause: GOAT (Nightly).app (pid 1632, started after the wp1 runs) listens on `*:3773`. Node-mode
pick-port (tunnel.ts:404-434) binds 127.0.0.1:3773 successfully beside the wildcard listener (macOS
SO_REUSEADDR), picks 3773, and node-mode wait_ready (tunnel.ts:1136-1144) is answered by the app, so
ensure returns before the fixture server exists. Probe logs: every node-mode pick was 3773
(/tmp/goat-ci/probe/run-1.pickport.log); only one fixture server ever listened on 3773
(run-1.listen.log). Not caused by the split; wp1's three runs passed with the app closed.
On Linux, binding 127.0.0.1 beside a 0.0.0.0 listener fails, so EPYC CI should not hit it.
Open: verification must move to EPYC/CI (user: no more tests on this Mac).

## Verification (wp2 C)

- Inventory diff vs baseline empty; all pass (same command as 010).
- Byte test and lock test durations from JSON vs wp1 run (expect ~10 s and ~4 s lower).
- typecheck, targeted lint, knip, fmt --check as in 010.
- `git diff origin/dev -- packages/ssh/src/tunnel.ts` empty (criterion c-4) unless step 3 amends.
