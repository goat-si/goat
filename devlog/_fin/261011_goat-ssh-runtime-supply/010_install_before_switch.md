# 010 — Install and verify before switching the SSH runner

## Loop spec

- Archetype: satisfy-spec; wp1 / item 2 / D1, owned by the parent loop.
- Trigger: the requested runtime may not exist in the release feed; replacing `run-t3.sh` first can disconnect a working environment.
- Goal: preparation failure preserves the installed runner, old runtime, ownership records, and running server; a successful replacement verifies the candidate before publishing it and before stopping a managed server. Pairing/MCP reuse the installed runner. Stale-forward recovery closes only that forward.
- Non-goals: D2 bundle acquisition, D3 identity/feed/packaging, D4 protocol compatibility, D9 local home selection, live SSH, app replacement, builds, releases, git operations, new child tasks, FSM/goal control. Remote GOAT state already uses `~/.goat`; this phase does not decide the packaged app's local home.
- Verifier: the isolated-HOME real-shell cases below, existing auth/disconnect tests, exact owning-package commands in §7, and manual review of the stop/publish boundary. **NOT RUN**: this PLAN WRITER leaf was explicitly forbidden to run builds/tests. Command existence and target coverage were checked from package/config source; no exit status is claimed.
- Stop: return this complete plan to the parent; implementation stops only when its behavioral gates and independent review pass.
- Memory artifact: this file and `000_plan.md`/`001_research.md`; later parent evidence goes in the owning unit, with no memory-store mutation.
- Expected terminal outcomes: executable plan delivered; parent implementation passes the specified gates; or a source drift/behavior conflict is returned for amendment. These are report outcomes, not FSM transitions.
- Escalation: parent approval for scope outside the file map, runner-switch serialization across different clients, or changes to shutdown ownership beyond the explicit-disconnect guard below. Archive-version equality is required by this amendment; Node-script dev runners are exempt from equality. No consultation/spawn was performed: this is the explicitly bounded delegated plan leaf; the parent owns consultation and audit.

## 1. Grounding and exact scope

Source root for all relative paths and all future commands:

```text
/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
```

The branch name `goat/ssh-runtime-supply` comes from the task packet. No git command was run to verify branch/HEAD. Recheck these source anchors before applying; line numbers refer to the tree read on 2026-10-11:

| Source                                                                                                            | Observed behavior                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ssh/src/tunnel.ts:303-311,557`                                                                          | `applyScriptPlaceholders` uses a string replacement in `replaceAll`; inserting a generated runner collapses its lock-owner `$$` to `$`. Use a function replacer, preserving all occurrences.                                          |
| `packages/ssh/src/tunnel.ts:610-646`                                                                              | Writes `RUNNER_NEXT`, installs it, chmods the published runner, then invokes its `--version`.                                                                                                                                         |
| `packages/ssh/src/tunnel.ts:713-751`                                                                              | Default-runtime adoption can stop the managed PID before the `RUNNER_CHANGED` branch; unchanged runners therefore need an explicit own-runtime branch too.                                                                            |
| `packages/ssh/src/tunnel.ts:784-815`                                                                              | Pairing directly overwrites `RUNNER_FILE`; replacement install unconditionally moves the candidate even when bytes match.                                                                                                             |
| `packages/ssh/src/tunnel.ts:839-852`                                                                              | MCP overwrites unless `keepExistingRunner` is true.                                                                                                                                                                                   |
| `packages/ssh/src/tunnel.ts:1128-1215`                                                                            | Preparation already recognizes a retained runner only with `keepExistingRunner` and a state key. A missing retained runtime fails instead of replacing the retained runner.                                                           |
| `packages/ssh/src/tunnel.ts:1307,1361`                                                                            | Pairing omits its state key; MCP supplies it but retains only when the input flag asks.                                                                                                                                               |
| `packages/ssh/src/tunnel.ts:1959-2012,2055`                                                                       | Entry finalizer stops the remote only if the entry still occupies the map. Stale recovery currently closes with that ownership still present. Explicit disconnect already deletes the entry first and invokes remote stop separately. |
| `packages/ssh/src/tunnel.test.ts:150-222`                                                                         | `nativeScripts` runs native Node to avoid Vite rewriting `Function.toString`; the frozen fixture protects runner/launch/pairing bytes.                                                                                                |
| `packages/ssh/src/tunnel.test.ts:825-1042`                                                                        | Existing retained tests explicitly expect pairing to acquire the requested newer version; revise that expectation.                                                                                                                    |
| `packages/ssh/src/tunnel.test.ts:1045-1138`                                                                       | Existing managed-reuse test explicitly omits `server-runtime.json`; it misses the own-runtime restart defect.                                                                                                                         |
| `packages/ssh/src/tunnel.mcpSession.test.ts:34,118,169`                                                           | Fixture still uses upstream `.t3` paths and expects replacement when the flag is false. Both assumptions conflict with D1/GOAT.                                                                                                       |
| `packages/ssh/src/tunnel.ts:1977,2138-2170`                                                                       | Scope finalization respects `leaveRemoteServerRunning`; explicit disconnect deletes/closes the entry then unconditionally stops the remote, bypassing the same policy.                                                                |
| `apps/server/src/sshRemote/SshRemoteDispatch.ts:626-633`; `apps/desktop/src/ssh/DesktopSshEnvironment.ts:168-172` | Server dispatch sets `leaveRemoteServerRunning: true`; desktop passes no override and retains owner behavior.                                                                                                                         |

| Operation | Path                                                    | Change                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MODIFY    | `packages/ssh/src/tunnel.ts`                            | Literal placeholder insertion, shared staging and expected archive-version check before publish, unchanged-runner preservation, auth retention, own-runtime reuse, local-only stale recovery/non-owner disconnect, preparation diagnostics. |
| MODIFY    | `packages/ssh/src/tunnel.test.ts`                       | Real-shell lifecycle/version/lock-PID tests, real remote-PID disconnect/shutdown policy tests, stale recovery, retained pairing/MCP expectations, native script extraction.                                                                 |
| MODIFY    | `packages/ssh/src/tunnel.mcpSession.test.ts`            | GOAT fixture paths and unconditional warm-runner retention expectations; keep ceiling-fallback tests.                                                                                                                                       |
| MODIFY    | `packages/ssh/src/fixtures/remote-runner-baseline.json` | Deliberately update **six entries only**: `archive.launch`, `archive.pairing`, `mirror.launch`, `mirror.pairing`, `node.launch`, `node.pairing`.                                                                                            |
| NEW       | none                                                    | Add helpers/tests within the existing owning test file.                                                                                                                                                                                     |
| DELETE    | none                                                    | Remove obsolete blocks within files, not files.                                                                                                                                                                                             |

No transport schema/type/enum is added. Creation/serialization/deserialization/consumers: N/A; the existing runner option is derived locally for auth preparation and not sent over a new wire contract. Desktop launch, server dispatch, pairing and MCP consume the shared SSH package. Web/mobile access through the existing server paths; no frontend entry point or provider adapter changes. No internal/user document addition is needed: the implementation constraint belongs beside the shared installer, and this plan is the parent-requested work artifact.

## 2. Ordered changes to `packages/ssh/src/tunnel.ts`

Apply in this order: (1) literal placeholder insertion; (2) shared staging + version check + installer blocks; (3) unchanged own-runtime branch; (4) builders + auth preparation; (5) stale recovery + explicit-disconnect guard; (6) contextual preparation errors. Do not alter `REMOTE_RUNNER_SCRIPT` or the upload patch anchors in this phase.

### 2.0 Preserve shell dollars at every placeholder insertion

The source uses `replaceAll`, rather than single-occurrence `replace`; retain its all-occurrence behavior and change only the replacement argument. A function's returned value is inserted literally, including `$$`, `$&`, and other replacement-string sequences. This must precede the new shared setup, which adds another level of generated-script insertion.

```diff
   for (const [token, value] of Object.entries(replacements)) {
-    result = result.replaceAll(`@@${token}@@`, value);
+    result = result.replaceAll(`@@${token}@@`, () => value);
   }
```

No export or test-only API is needed. The public builders exercise nested substitution. Existing runner-template lock ownership at source line 557 remains unchanged; generated launch/pairing/MCP runners must retain the quoted `$$` and record their executing shell PID, not a literal dollar. Tests are in §3.1 and §3.4; the six frozen wrapper entries are deliberately regenerated in §5.

### 2.1 Shared staging: candidate cleanup and requested-version diagnostic

Insert this **new block inside the existing file**, immediately before `const REMOTE_LAUNCH_SCRIPT`:

```diff
+// Publishing a runner is the switch boundary. Execute the candidate first;
+// auth commands keep an existing runner so they match its running server.
+const REMOTE_RUNNER_SETUP_SCRIPT = `RUNNER_FILE="$STATE_DIR/run-t3.sh"
+RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
+REQUESTED_RUNNER=@@T3_REQUESTED_RUNNER@@
+EXPECTED_ARCHIVE_VERSION=@@T3_EXPECTED_ARCHIVE_VERSION@@
+mkdir -p "$STATE_DIR"
+cleanup_runner_next() {
+  rm -f "$RUNNER_NEXT"
+}
+trap cleanup_runner_next EXIT
+trap 'exit 129' HUP
+trap 'exit 130' INT
+trap 'exit 143' TERM
+cat >"$RUNNER_NEXT" <<'SH'
+@@T3_RUNNER_SCRIPT@@
+SH
+verify_runner_next() {
+  chmod 700 "$RUNNER_NEXT"
+  if ! RUNNER_VERSION_OUTPUT="$("$RUNNER_NEXT" --version)"; then
+    printf 'Cannot prepare %s on this host. The existing runner and server have been left unchanged. Supply a valid archive for the requested version in the local SSH runtime archive directory, or configure a release mirror containing that version, then retry.\\n' "$REQUESTED_RUNNER" >&2
+    exit 1
+  fi
+  if [ -n "$EXPECTED_ARCHIVE_VERSION" ] && [ "$RUNNER_VERSION_OUTPUT" != "goat v$EXPECTED_ARCHIVE_VERSION" ]; then
+    printf 'Cannot prepare %s: expected goat v%s, but the candidate reported "%s". The existing runner and server have been left unchanged. Supply the correct requested archive in the local SSH runtime archive directory or release mirror, and have the owning client clear the rejected version cache at %s before retrying.\\n' "$REQUESTED_RUNNER" "$EXPECTED_ARCHIVE_VERSION" "$RUNNER_VERSION_OUTPUT" "$HOME/.goat/runtime/goat/versions/$EXPECTED_ARCHIVE_VERSION" >&2
+    exit 1
+  fi
+}
+RUNNER_CHANGED=0
+@@T3_RUNNER_INSTALL@@
+`;
+
 const REMOTE_LAUNCH_SCRIPT = `set -eu
```

Keep candidate stderr visible, including missing-release URLs, checksum mismatch or executable failure. Capture only `--version` stdout; successful verification does not emit it into launch/auth JSON. Command substitution removes trailing newlines; require the remaining archive output to equal `goat v<requested exact version>`. Empty output, malformed output and a different version all fail before rename or remote stop. Do not put a credential, auth token or session result in this message. A Node-script request uses its source path as the requested-runner label and an empty expected version: it must execute successfully, but its dev version need not equal an archive version. Retained/byte-identical runners do not undergo new candidate verification.

Replace the following real launch hunk; preserve everything from `T3_ARCHIVE_MODE` onward:

```diff
 LOG_FILE="$STATE_DIR/server.log"
-RUNNER_FILE="$STATE_DIR/run-t3.sh"
-RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
-mkdir -p "$STATE_DIR"
-cleanup_runner_next() {
-  rm -f "$RUNNER_NEXT"
-}
-trap cleanup_runner_next EXIT
-cat >"$RUNNER_NEXT" <<'SH'
-@@T3_RUNNER_SCRIPT@@
-SH
-RUNNER_CHANGED=0
-@@T3_RUNNER_INSTALL@@
-chmod 700 "$RUNNER_FILE"
+@@T3_RUNNER_SETUP@@
 T3_ARCHIVE_MODE=@@T3_ARCHIVE_MODE@@
```

Replace both existing install constants and their comments:

```diff
-// How the launch script installs the runner it just wrote to RUNNER_NEXT.
-// The default replaces a changed runner and flags RUNNER_CHANGED, which
-// restarts a managed server; its bytes are part of the frozen launch baseline.
-const REPLACE_RUNNER_INSTALL = `if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
-  RUNNER_CHANGED=1
-fi
-mv "$RUNNER_NEXT" "$RUNNER_FILE"`;
+// Matching bytes preserve the installed file and do not restart a server.
+const REPLACE_RUNNER_INSTALL = `if [ -f "$RUNNER_FILE" ] && cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
+  rm -f "$RUNNER_NEXT"
+else
+  verify_runner_next
+  mv "$RUNNER_NEXT" "$RUNNER_FILE"
+  RUNNER_CHANGED=1
+fi`;
 // A second client of the host keeps whatever runner is already there, so it
 // never restarts a server another client launched.
 const KEEP_EXISTING_RUNNER_INSTALL = `if [ -f "$RUNNER_FILE" ]; then
   rm -f "$RUNNER_NEXT"
 else
+  verify_runner_next
   mv "$RUNNER_NEXT" "$RUNNER_FILE"
 fi`;
```

`chmod` acts on the candidate only. An existing file that is not executable produces the existing execution error; do not chmod, overwrite or remove it as an implicit repair. Missing runtime/invalid retained version continues to fail during preparation. Candidate rename failure also exits before any server-stop path. Traps clean the candidate on normal failure and handled signals; SIGKILL cannot run a shell trap and remains a documented residual risk.

### 2.2 Preserve own default-runtime reuse with an identical runner

The original default adoption branch stops a managed server when `server-runtime.json` describes that same server. Add this constant immediately before `KEEP_OWN_RUNTIME_CHECK` (leave the keep-existing constant's behavior unchanged):

```diff
+// A managed server also writes the default runtime descriptor. Keep its
+// ownership here; the later RUNNER_CHANGED branch alone decides replacement.
+const REPLACE_OWN_RUNTIME_CHECK = `if [ "$REMOTE_MANAGED" = "managed" ] && [ -n "$REMOTE_PID" ] && [ "$REMOTE_PID" = "$DEFAULT_RUNTIME_PID" ]; then
+      REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
+    el`;
+
 const KEEP_OWN_RUNTIME_CHECK = `if [ "$REMOTE_MANAGED" = "managed" ]; then
```

The existing `@@T3_OWN_RUNTIME_CHECK@@if ...` composition turns `el` + `if` into `elif`; retain that existing composition convention for this focused change. Both constants must produce syntactically valid generated shell. When the default descriptor belongs to a different external PID, preserve the existing adoption behavior. When it is our managed PID, keep managed ownership and let the already-existing later branch restart only when `RUNNER_CHANGED=1`.

### 2.3 Pairing and MCP use the shared setup in keep mode

Replace pairing's direct writer:

```diff
 DEFAULT_SERVER_HOME="$HOME/.goat"
-RUNNER_FILE="$STATE_DIR/run-t3.sh"
-mkdir -p "$STATE_DIR"
-cat >"$RUNNER_FILE" <<'SH'
-@@T3_RUNNER_SCRIPT@@
-SH
-chmod 700 "$RUNNER_FILE"
+@@T3_RUNNER_SETUP@@
 PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
 "$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
```

Replace MCP's option-dependent direct writer:

```diff
 DEFAULT_SERVER_HOME="$HOME/.goat"
-RUNNER_FILE="$STATE_DIR/run-t3.sh"
-mkdir -p "$STATE_DIR"
-if [ "@@T3_KEEP_EXISTING_RUNNER@@" != "1" ] || [ ! -f "$RUNNER_FILE" ]; then
-  cat >"$RUNNER_FILE" <<'SH'
-@@T3_RUNNER_SCRIPT@@
-SH
-  chmod 700 "$RUNNER_FILE"
-fi
+@@T3_RUNNER_SETUP@@
 set -- auth session issue --base-dir "$DEFAULT_SERVER_HOME" --subject mcp-client --scope orchestration:read --scope orchestration:operate --ttl @@T3_TTL@@ --label @@T3_LABEL@@ --json
```

Do not change ceiling retry/output decoding. A missing runner stages/verifies/publishes; an existing runner is retained regardless of the caller's keep flag. Launch remains the only entry point that can intentionally replace an installed runner.

Add this internal builder immediately after `buildRemoteNodeEnvScript`, before `buildRemoteLaunchScript`:

```diff
+function buildRemoteRunnerSetupScript(
+  input: RemoteT3RunnerOptions | undefined,
+  keepExistingRunner: boolean,
+): string {
+  const requestedRunner = isNodeScriptRunner(input)
+    ? `Node script ${input?.nodeScriptPath?.trim()}`
+    : `GOAT ${input?.archiveVersion?.trim()}`;
+  return applyScriptPlaceholders(REMOTE_RUNNER_SETUP_SCRIPT, {
+    T3_REQUESTED_RUNNER: shellSingleQuote(requestedRunner),
+    T3_EXPECTED_ARCHIVE_VERSION: shellSingleQuote(
+      isNodeScriptRunner(input) ? "" : input?.archiveVersion?.trim() || "",
+    ),
+    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
+    T3_RUNNER_INSTALL: keepExistingRunner
+      ? KEEP_EXISTING_RUNNER_INSTALL
+      : REPLACE_RUNNER_INSTALL,
+  });
+}
+
 export function buildRemoteLaunchScript(input?: RemoteT3RunnerOptions): string {
```

Apply these three builder hunks:

```diff
     T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
-    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
+    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, input?.keepExistingRunner === true),
     T3_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
@@
-    T3_RUNNER_INSTALL: input?.keepExistingRunner
-      ? KEEP_EXISTING_RUNNER_INSTALL
-      : REPLACE_RUNNER_INSTALL,
-    T3_OWN_RUNTIME_CHECK: input?.keepExistingRunner ? KEEP_OWN_RUNTIME_CHECK : "",
+    T3_OWN_RUNTIME_CHECK: input?.keepExistingRunner
+      ? KEEP_OWN_RUNTIME_CHECK
+      : REPLACE_OWN_RUNTIME_CHECK,
     T3_BUSY_SERVER_GUARD: input?.keepExistingRunner ? KEEP_BUSY_SERVER_GUARD : "",
@@
   return applyScriptPlaceholders(REMOTE_MCP_SESSION_SCRIPT, {
     T3_STATE_KEY: stateKey,
-    T3_KEEP_EXISTING_RUNNER: input?.keepExistingRunner ? "1" : "0",
     T3_TTL: shellSingleQuote(options.ttl),
@@
-    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
+    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, true),
   });
 }
@@
   return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
     T3_STATE_KEY: stateKey,
-    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
+    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, true),
   });
 }
```

The `T3_RUNNER_SCRIPT` replacement in `buildRemoteT3RunnerScript` is **not** affected; apply the first hunk only to `buildRemoteLaunchScript`.

Make preparation honor the same unconditional auth retention policy, using the existing state key:

```diff
   yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
     ...sshTargetLogFields(target),
     stateKey,
   });
-  yield* prepareRemoteRuntime(target, input ?? {}, runner);
+  yield* prepareRemoteRuntime(target, input ?? {}, { ...runner, keepExistingRunner: true }, stateKey);
   const result = yield* runSshCommand(target, {
@@
-    yield* prepareRemoteRuntime(target, input ?? {}, runner, stateKey);
+    yield* prepareRemoteRuntime(target, input ?? {}, { ...runner, keepExistingRunner: true }, stateKey);
     const result = yield* runSshCommand(target, {
       remoteCommandArgs: ["sh", "-s"],
       stdin: buildRemoteMcpSessionScript(stateKey, sessionOptions, runner),
```

Apply the second hunk only in `issueRemoteMcpClientSession`; do not change the launch preparation call. Existing invalid/missing retained-runtime errors remain fail-closed. Do not delete a retained runner as part of this implementation.

### 2.4 Stale-forward recovery relinquishes stop ownership first

At the existing stale path in `ensureTunnelEntry`:

```diff
         cause: readinessExit.cause,
       });
-      yield* closeTunnelEntry(entry);
+      // A failed local forward is not authority to stop its remote server.
+      // Remove ownership before closing so the scope finalizer stays local.
+      yield* Effect.gen(function* () {
+        if (tunnels.get(key) === entry) {
+          tunnels.delete(key);
+        }
+        yield* closeTunnelEntry(entry);
+      }).pipe(Effect.uninterruptible);
     }
```

The target lock already serializes `ensureEnvironment`/disconnect; do not introduce a second lock. Identity-check deletion prevents an old entry from deleting a replacement. Uninterruptibility protects the deletion/close pair; existing bounded local kill semantics remain. Preserve manager-shutdown policy; explicit disconnect must honor that same manager option as specified in §2.6.

This guarantees stale-scope closure itself never issues a remote stop. A subsequent normal launch still follows the configured runner replacement policy; a successfully verified intentional upgrade can restart a managed server. For the acceptance case, reconnect requests the same runner, so both closure and reconnect leave the remote PID alive. Do not claim the stronger statement that stale recovery suppresses every independently requested future upgrade.

### 2.5 Local preparation errors include the requested version

The shell diagnostic covers direct mirror installation. Local-cache errors such as the 256 MiB limit currently omit the requested version. Wrap only existing `SshLaunchError` values at the outer preparation boundary, retaining cause/stdout; do not turn transport/auth errors into a different error class:

```diff
     yield* Effect.annotateCurrentSpan("t3.runtime.upload.installComplete", true);
-  }).pipe(Effect.withSpan("ssh.prepareRemoteRuntime"));
+  }).pipe(
+    Effect.mapError((error) =>
+      error instanceof SshLaunchError
+        ? new SshLaunchError({
+            message: `Cannot prepare GOAT ${runner?.archiveVersion?.trim() || "(node-script runner)"} on ${target.alias}: ${error.message} The existing runner and server have been left unchanged. Supply the requested runtime archive in the local SSH runtime archive directory or a release mirror, then retry.`,
+            stdout: error.stdout,
+            cause: error,
+          })
+        : error,
+    ),
+    Effect.withSpan("ssh.prepareRemoteRuntime"),
+  );
```

Auth retry must still recognize `SshCommandError` from upload. Existing probe normalization behavior predates this unit; do not expand this change into its redesign. Error text for a missing retained older runtime must retain that older version and owner-client recovery advice; the prefix also names the newer version the current client requested.

### 2.6 Non-owner explicit disconnect closes only its local forward

After the existing entry deletion/scope closure, guard the standalone stop in `disconnectEnvironment`. This real source hunk preserves owner stop failure propagation and stopping without a cached local entry:

```diff
         if (entry !== null) {
-          // Explicit disconnect owns the remote stop so its failure reaches the caller.
+          // Remove this entry before closure; an owner stops explicitly below.
           yield* Effect.gen(function* () {
             tunnels.delete(key);
             yield* closeTunnelEntry(entry);
           }).pipe(Effect.uninterruptible);
         }
-        yield* runWithSshAuth({
-          key,
-          target: resolvedTarget,
-          operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
-        });
+        if (options.leaveRemoteServerRunning !== true) {
+          yield* runWithSshAuth({
+            key,
+            target: resolvedTarget,
+            operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
+          });
+        }
```

The server dispatch manager (`leaveRemoteServerRunning: true`) closes its local forward on both explicit disconnect and manager shutdown; it never issues remote stop, including a repeated disconnect with no cached entry. Desktop supplies the default option and remains the owner: explicit disconnect stops the managed remote and exposes stop failure to the caller, even when there is no cached forward. Its shutdown finalizer still stops a remote for an entry it owns, after closing its local forward, and still ignores finalizer failures. The existing stop script preserves external servers. No changes to finalizer policy or desktop/server construction are proposed. §3.5 tests both explicit disconnect and scope shutdown with a real captured remote PID.

## 3. Behavioral tests in `packages/ssh/src/tunnel.test.ts`

These are real generated-shell tests, not string-order assertions. Production shell may use its existing bounded readiness/exit waiting; the test harness synchronizes using process output/FIFO/Deferred and never adds sleep/poll-based acceptance. Every real child has a captured handle or a PID emitted by this fixture. Never discover or kill a process by pattern.

### 3.1 Native script extraction and existing assertions

Extend `nativeScripts` to extract the MCP script too. The baseline assertion still compares the three existing protected fields:

```diff
-console.log(JSON.stringify({ runner: t.buildRemoteT3RunnerScript(input), launch: t.buildRemoteLaunchScript(input), pairing: t.buildRemotePairingScript("711bc738002d72fd", input), upload: input.nodeScriptPath ? null : t.buildRemoteT3UploadInstallerScript(input, "A".repeat(64)) }));`;
+console.log(JSON.stringify({ runner: t.buildRemoteT3RunnerScript(input), launch: t.buildRemoteLaunchScript(input), pairing: t.buildRemotePairingScript("711bc738002d72fd", input), mcp: t.buildRemoteMcpSessionScript("711bc738002d72fd", { label: "fixture", ttl: "1h", runtimeModeCeiling: null }, input), upload: input.nodeScriptPath ? null : t.buildRemoteT3UploadInstallerScript(input, "A".repeat(64)) }));`;
@@
     pairing: string;
+    mcp: string;
     upload: string | null;
```

Add these tests beside the existing frozen-byte test. They use native generation so Vite does not change nested script bytes, and test every wrapper including MCP. The first test prevents `$$` collapse; the second checks replacement-string metacharacters in a quoted input.

```ts
it.effect("preserves literal shell PIDs through every nested script builder", () =>
  Effect.gen(function* () {
    const lockOwner = `printf '%s\\n' "$$" > "$T3_LOCK/pid.tmp"`;
    for (const input of [
      ARCHIVE,
      { ...ARCHIVE, releaseBaseUrl: "https://example.invalid/mirror/" },
      { nodeScriptPath: "/fixture/cli entry.mjs", nodeEngineRange: TEST_NODE_ENGINE_RANGE },
    ]) {
      const generated = yield* nativeScripts(input);
      for (const field of ["runner", "launch", "pairing", "mcp"] as const) {
        assert.include(generated[field], lockOwner, field);
        assert.notInclude(generated[field], `printf '%s\\n' "$" > "$T3_LOCK/pid.tmp"`, field);
      }
      for (const field of ["launch", "pairing", "mcp"] as const) {
        assert.include(generated[field], 'RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"', field);
        const nested = generated[field].split("<<'SH'\n")[1]!.split("\nSH\n")[0]!;
        assert.equal(nested, generated.runner, field);
      }
      if (generated.upload !== null) assert.include(generated.upload, lockOwner);
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("inserts dollar metacharacters literally in nested quoted runner paths", () =>
  Effect.gen(function* () {
    const generated = yield* nativeScripts({ nodeScriptPath: "/fixture/dollar $$ $& entry.mjs" });
    for (const field of ["runner", "launch", "pairing", "mcp"] as const) {
      assert.include(generated[field], "T3_NODE_SCRIPT_PATH='/fixture/dollar $$ $& entry.mjs'");
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
```

The existing launch string assertion expects `elif ! ensure_remote_node_path` and stays applicable because §2.1 preserves that branch. Keep the fixture-byte assertions; do not replace behavior tests with new assertions of `verify_runner_next` spelling.

Revise the retained-runtime matrix: add pairing to all existing modes, and apply ready/dev/missing handling uniformly. These exact local hunks remove the obsolete special pairing exception:

```diff
     { entry: "pairing", mode: "ready" },
+    { entry: "pairing", mode: "missing" },
+    { entry: "pairing", mode: "dev" },
+    { entry: "pairing", mode: "none" },
+    { entry: "pairing", mode: "invalid" },
+    { entry: "pairing", mode: "upstream-only" },
+    { entry: "pairing", mode: "marker-only" },
+    { entry: "pairing", mode: "non-executable" },
+    { entry: "pairing", mode: "wrong-marker" },
@@
-      if (entry === "pairing") {
-        assert.isTrue(Result.isSuccess(result));
-        assert.deepEqual(calls, ["probe", "gh", "upload", "pairing"]);
-        assert.isAbove(cacheReads, 0);
-        assert.deepEqual(yield* fs.readFile(`${archiveDirectory}/${asset}`), bytes);
-      } else if (mode === "ready" || mode === "dev") {
+      if (mode === "ready" || mode === "dev") {
@@
-            assert.equal(
+            assert.include(
               result.failure.message,
               `The retained runner ~/.goat/ssh-launch/${stateKey}/run-t3.sh selects goat ${retainedVersion}, which is not installed on ${uploadTarget.alias}. This client reuses that runner and will not replace it; reconnect from the client that owns it, or remove the runner to let this client install its own runtime.`,
             );
+            assert.include(result.failure.message, ARCHIVE.archiveVersion);
```

Delete the obsolete nested pairing success branch in the `gh` fake; now every cold `none` case expects the existing `gh` failure and `calls=["probe","gh"]`. Do not introduce fake upload success for invalid archive bytes.

```diff
           if (command.command === "gh") {
             calls.push("gh");
-            if (entry === "pairing") {
-              assert.include(command.args, `v${ARCHIVE.archiveVersion}`);
-              assert.include(command.args, asset);
-              assert.notInclude(command.args, `v${retainedVersion}`);
-              const staging = command.args[command.args.indexOf("--dir") + 1];
-              assert.isDefined(staging);
-              if (staging === undefined) return makeSuccessfulProcess("");
-              yield* fs.writeFile(`${staging}/${asset}`, bytes);
-              yield* fs.writeFileString(`${staging}/SHA256SUMS`, `${sha256}  ${asset}\n`);
-              return makeSuccessfulProcess("");
-            }
             return {
               ...makeSuccessfulProcess(""),
               exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
             };
```

That deletion makes the retained matrix's fake upload payload helpers obsolete. Remove its local `bytes`, `crypto`, `sha256`, and `asset` declarations and the upload branch's `assert.deepEqual(data, bytes)`; real upload payload validation remains in the existing upload tests. This prevents unused variables after the expectation change. Exact declarations to remove in this matrix only:

```diff
       const archiveDirectory = `${root}/missing-cache`;
-      const bytes = new Uint8Array([0, 128, 255]);
-      const crypto = yield* Crypto.Crypto;
-      const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes));
-      const asset = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`;
       const calls: string[] = [];
@@
           if (command.args.includes("-c")) {
             calls.push("upload");
-            assert.deepEqual(data, bytes);
             assert.include(command.args.join(" "), ARCHIVE.archiveVersion);
```

For the two pretty-JSON pairing tests at source lines 563 and 589, preparation now performs a probe even on the mirror path. Replace each constant-output spawner with an Effect generator that drains its command stdin, returns `JSON.stringify({ platform, arch, ready: true })` when the input contains `ready=false`, and otherwise returns the **same original noisy/pretty credential output**. Keep the returned credential assertions. Exact wrapper to use around each existing credential literal:

```ts
const spawner = ChildProcessSpawner.make((command) =>
  Effect.gen(function* () {
    const input = command._tag === "StandardCommand" ? command.options.stdin : undefined;
    const bytes =
      input !== undefined &&
      typeof input === "object" &&
      "stream" in input &&
      Stream.isStream(input.stream)
        ? yield* input.stream.pipe(Stream.runCollect)
        : [];
    const script = new TextDecoder().decode(
      new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk))),
    );
    if (script.includes("ready=false")) {
      return makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: true }));
    }
    return makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`);
  }),
);
```

For the noisy test, prefix that literal with its existing `loaded nvm default\n`.

Strengthen the existing local-cache error test, with this hunk only in `"surfaces local archive preparation errors during pairing"`:

```diff
-      if (Result.isFailure(result)) assert.instanceOf(result.failure, SshLaunchError);
+      if (Result.isFailure(result)) {
+        assert.instanceOf(result.failure, SshLaunchError);
+        assert.include(result.failure.message, ARCHIVE.archiveVersion);
+        assert.include(result.failure.message, "local SSH runtime archive directory");
+      }
       assert.equal(calls, 1);
```

### 3.2 Real-shell harness to append in this file

Append the following block after the existing suites. It executes **native generated bytes** using real `sh`, `tar`, checksum tools and loopback HTTP. No SSH transport or external release request occurs; the mirror is `file://` and HOME is a scoped temp directory. Use `it.live` because native process milestones are outside TestClock; Windows skips only these POSIX-shell cases.

```ts
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "install before runner switch",
  () => {
    const stateKey = "711bc738002d72fd";
    const oldVersion = "1.2.2-preview.20260910.1";
    const nextVersion = ARCHIVE.archiveVersion;

    const shell = Effect.fn("test.runnerSwitch.shell")(function* (
      home: string,
      script: string,
      args: string[] = [],
      pathValue: string = process.env.PATH ?? "",
    ) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-s", "--", ...args], {
          env: { HOME: home, PATH: pathValue, LC_ALL: "C" },
          extendEnv: false,
          stdin: { stream: Stream.make(encoder.encode(script)), endOnDone: true },
        }),
      );
      return yield* Effect.all(
        {
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          code: child.exitCode.pipe(Effect.map(Number)),
        },
        { concurrency: "unbounded" },
      );
    });

    // Written into the old runtime and the tiny release archive. This is a
    // behavioral double for the executable, not a duplicate of the installer.
    const executable = (version: string) => `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const home = process.env.HOME;
const fixture = path.join(home, ".test");
const version = ${JSON.stringify(version)};
const config = JSON.parse(fs.readFileSync(path.join(fixture, "config.json"), "utf8"));
const state = path.join(home, ".goat/ssh-launch/${stateKey}");
const runtimeFile = path.join(home, ".goat/userdata/server-runtime.json");
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function event(type, extra = {}) {
  fs.appendFileSync(path.join(fixture, "events"), JSON.stringify({ type, version, ...extra }) + "\\n");
}
function runtime() { try { return JSON.parse(fs.readFileSync(runtimeFile, "utf8")); } catch { return null; } }
const args = process.argv.slice(2);
if (args[0] === "--version") {
  let runner = "";
  try { runner = fs.readFileSync(path.join(state, "run-t3.sh"), "utf8"); } catch {}
  const old = runtime();
  event("version", { runner, oldAlive: Boolean(old && alive(old.pid)) });
  console.log("goat v" + version);
} else if (args[0] === "__ssh-helper") {
  if (args[1] === "runtime-port") {
    const current = runtime();
    if (!config.publishDefault || !current || !alive(current.pid)) process.exit(1);
    console.log(current.pid + " " + current.port);
  } else if (args[1] === "pick-port") {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => console.log(port));
    });
  } else if (args[1] === "wait-ready") {
    let current = runtime();
    const accepted = current && (current.pid === config.seedPid ||
      fs.existsSync(path.join(fixture, "accepted-ready-" + current.pid)));
    if (!current || !alive(current.pid) || !accepted) {
      // The new serve command writes only after listening; no test sleeps.
      const fd = fs.openSync(path.join(fixture, "ready.fifo"), "r");
      fs.readSync(fd, Buffer.alloc(32), 0, 32, null);
      fs.closeSync(fd);
      current = runtime();
      if (current) fs.writeFileSync(path.join(fixture, "accepted-ready-" + current.pid), "ready");
    }
    if (!current || Number(args[2]) !== current.port) process.exit(1);
    const request = http.get("http://127.0.0.1:" + current.port + "/", response => {
      response.resume();
      response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
    });
    request.on("error", () => process.exit(1));
  } else process.exit(2);
} else if (args[0] === "auth") {
  event("auth", { args });
  if (args[1] === "pairing") console.log(JSON.stringify({ credential: "fixture-pairing" }));
  else console.log(JSON.stringify({ token: "fixture-session", expiresAt: null }));
} else if (args[0] === "serve") {
  const requested = args.indexOf("--port");
  const port = requested < 0 ? 0 : Number(args[requested + 1]);
  const server = http.createServer((_request, response) => response.end("ok"));
  process.on("SIGTERM", () => {
    event("stop");
    if (runtime()?.pid === process.pid) fs.unlinkSync(runtimeFile);
    server.close(() => process.exit(0));
  });
  server.listen(port, "127.0.0.1", () => {
    const record = { pid: process.pid, port: server.address().port,
      origin: "http://127.0.0.1:" + server.address().port };
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(runtimeFile, JSON.stringify(record));
    fs.appendFileSync(path.join(fixture, "pids"), process.pid + "\\n");
    const installed = fs.existsSync(path.join(state, "run-t3.sh"))
      ? fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") : "";
    const marker = path.join(home, ".goat/runtime/goat/versions", version, ".install-complete");
    event("start", { installed, complete: fs.readFileSync(marker, "utf8").trim() });
    if (args.includes("--test-seed")) console.log(JSON.stringify(record));
    else {
      const fd = fs.openSync(path.join(fixture, "ready.fifo"), "w");
      fs.writeSync(fd, "ready\\n");
      fs.closeSync(fd);
    }
  });
} else process.exit(2);
`;

    const fixture = Effect.fn("test.runnerSwitch.fixture")(function* (
      failure: "none" | "missing-release" | "bad-checksum" | "broken-executable" | "wrong-version",
      options: { seed?: boolean; identical?: boolean; publishDefault?: boolean } = {},
    ) {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-switch-" });
      const state = `${home}/.goat/ssh-launch/${stateKey}`;
      const previous = options.identical ? nextVersion : oldVersion;
      const oldRuntime = `${home}/.goat/runtime/goat/versions/${previous}`;
      const test = `${home}/.test`;
      yield* fs.makeDirectory(state, { recursive: true });
      yield* fs.makeDirectory(test, { recursive: true });
      yield* fs.writeFileString(`${test}/events`, "");
      yield* fs.writeFileString(`${test}/pids`, "");
      const upstream = `${home}/.t3/runtime/versions/${previous}`;
      yield* fs.makeDirectory(upstream, { recursive: true });
      yield* fs.writeFileString(`${upstream}/t3`, "upstream executable sentinel\n");
      yield* fs.writeFileString(`${upstream}/.install-complete`, `${previous}\n`);
      yield* fs.writeFileString(
        `${test}/config.json`,
        JSON.stringify({
          publishDefault: options.publishDefault !== false,
        }),
      );
      const fifo = yield* spawner.spawn(ChildProcess.make("mkfifo", [`${test}/ready.fifo`]));
      assert.equal(Number(yield* fifo.exitCode), 0);
      // Register last-created server cleanup before any server is started.
      // Every PID below is emitted by this fixture's executable, not searched.
      yield* Effect.addFinalizer(() =>
        fs.readFileString(`${test}/pids`).pipe(
          Effect.flatMap((data) =>
            Effect.sync(() => {
              for (const pid of data.trim().split("\n").filter(Boolean).map(Number)) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {
                  /* already exited */
                }
              }
            }),
          ),
          Effect.ignore,
        ),
      );
      const mirror = `file://${home}/mirror`;
      const runner = { ...ARCHIVE, releaseBaseUrl: mirror };
      const scripts = yield* nativeScripts(runner);
      const oldScripts = yield* nativeScripts({ archiveVersion: previous, releaseBaseUrl: mirror });
      let oldProcess: ChildProcessSpawner.ChildProcessHandle | null = null;
      if (options.seed !== false) {
        yield* fs.makeDirectory(oldRuntime, { recursive: true });
        yield* fs.writeFileString(`${oldRuntime}/goat`, executable(previous));
        yield* fs.chmod(`${oldRuntime}/goat`, 0o700);
        yield* fs.writeFileString(`${oldRuntime}/.install-complete`, `${previous}\n`);
        yield* fs.writeFileString(`${state}/run-t3.sh`, oldScripts.runner + "\n");
        yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
        oldProcess = yield* spawner.spawn(
          ChildProcess.make(`${oldRuntime}/goat`, ["serve", "--test-seed"], {
            env: { HOME: home, PATH: process.env.PATH ?? "" },
            extendEnv: false,
          }),
        );
        const ready = JSON.parse(
          yield* oldProcess.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.take(1),
            Stream.mkString,
          ),
        ) as { pid: number; port: number };
        assert.equal(ready.pid, oldProcess.pid);
        yield* fs.writeFileString(
          `${test}/config.json`,
          JSON.stringify({
            publishDefault: options.publishDefault !== false,
            seedPid: ready.pid,
          }),
        );
        yield* fs.writeFileString(`${state}/pid`, `${ready.pid}\n`);
        yield* fs.writeFileString(`${state}/port`, `${ready.port}\n`);
        yield* fs.writeFileString(`${state}/managed`, "managed\n");
      }
      const stem = `goat-${nextVersion}-${platform}-${arch}`;
      const release = `${home}/mirror/v${nextVersion}`;
      const stage = `${home}/stage/${stem}`;
      yield* fs.makeDirectory(stage, { recursive: true });
      yield* fs.makeDirectory(release, { recursive: true });
      yield* fs.writeFileString(
        `${stage}/goat`,
        failure === "broken-executable"
          ? "#!/bin/sh\nprintf 'wrong architecture\\n' >&2\nexit 95\n"
          : executable(failure === "wrong-version" ? oldVersion : nextVersion),
      );
      yield* fs.chmod(`${stage}/goat`, 0o700);
      const packed = yield* spawner.spawn(
        ChildProcess.make("tar", [
          "-czf",
          `${release}/${stem}.tar.gz`,
          "-C",
          `${home}/stage`,
          stem,
        ]),
      );
      assert.equal(Number(yield* packed.exitCode), 0);
      const crypto = yield* Crypto.Crypto;
      const sum = Hex.encode(
        yield* crypto.digest("SHA-256", yield* fs.readFile(`${release}/${stem}.tar.gz`)),
      );
      yield* fs.writeFileString(
        `${release}/SHA256SUMS`,
        `${failure === "bad-checksum" ? "0".repeat(64) : sum}  ${stem}.tar.gz\n`,
      );
      if (failure === "missing-release") yield* fs.remove(release, { recursive: true });
      const snapshot = Effect.gen(function* () {
        const files = ["run-t3.sh", "pid", "port", "managed"];
        const values: Record<string, unknown> = {};
        for (const file of files)
          if (yield* fs.exists(`${state}/${file}`)) {
            values[file] = yield* fs.readFileString(`${state}/${file}`);
          }
        if (yield* fs.exists(`${state}/run-t3.sh`)) {
          const info = yield* fs.stat(`${state}/run-t3.sh`);
          values.runnerMetadata = { ino: info.ino, mode: info.mode, mtime: info.mtime };
        }
        if (yield* fs.exists(oldRuntime)) {
          values.oldExecutable = yield* fs.readFileString(`${oldRuntime}/goat`);
          values.oldMarker = yield* fs.readFileString(`${oldRuntime}/.install-complete`);
          for (const file of ["goat", ".install-complete"]) {
            const info = yield* fs.stat(`${oldRuntime}/${file}`);
            values[`oldMetadata:${file}`] = { ino: info.ino, mode: info.mode, mtime: info.mtime };
          }
        }
        const descriptor = `${home}/.goat/userdata/server-runtime.json`;
        if (yield* fs.exists(descriptor)) values.descriptor = yield* fs.readFileString(descriptor);
        values.upstreamExecutable = yield* fs.readFileString(`${upstream}/t3`);
        values.upstreamMarker = yield* fs.readFileString(`${upstream}/.install-complete`);
        return values;
      });
      const events = fs.readFileString(`${test}/events`).pipe(
        Effect.map((data) =>
          data
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  type: string;
                  version: string;
                  runner?: string;
                  oldAlive?: boolean;
                  installed?: string;
                  complete?: string;
                },
            ),
        ),
      );
      const cleanCandidates = Effect.gen(function* () {
        assert.deepEqual(
          (yield* fs.readDirectory(state)).filter((name) => name.startsWith("run-t3.next.")),
          [],
        );
      });
      return { home, state, runner, scripts, oldProcess, snapshot, events, cleanCandidates, fs };
    });

    it.live.each([
      { failure: "missing-release", publishDefault: true },
      { failure: "missing-release", publishDefault: false },
      { failure: "bad-checksum", publishDefault: true },
      { failure: "bad-checksum", publishDefault: false },
      { failure: "broken-executable", publishDefault: true },
      { failure: "broken-executable", publishDefault: false },
      { failure: "wrong-version", publishDefault: true },
      { failure: "wrong-version", publishDefault: false },
    ] as const)(
      "$failure preserves the live server (default descriptor=$publishDefault)",
      ({ failure, publishDefault }) =>
        Effect.gen(function* () {
          const f = yield* fixture(failure, { publishDefault });
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
          assert.notEqual(result.code, 0);
          assert.include(result.stderr, nextVersion);
          assert.include(result.stderr, "existing runner and server");
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
          yield* f.cleanCandidates;
          if (failure === "wrong-version") {
            assert.include(result.stderr, `expected goat v${nextVersion}`);
            assert.include(result.stderr, `reported "goat v${oldVersion}"`);
            assert.isTrue(
              (yield* f.events).some(
                (event) =>
                  event.type === "version" && event.version === oldVersion && event.oldAlive,
              ),
            );
          } else {
            assert.isFalse(
              yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/${nextVersion}`),
            );
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("verifies, publishes, stops, then starts on a successful upgrade", () =>
      Effect.gen(function* () {
        const f = yield* fixture("none");
        const before = yield* f.snapshot;
        const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
        assert.equal(result.code, 0, result.stderr);
        const events = yield* f.events;
        const verified = events.findIndex(
          (event) => event.type === "version" && event.version === nextVersion,
        );
        const stopped = events.findIndex(
          (event) => event.type === "stop" && event.version === oldVersion,
        );
        const started = events.findIndex(
          (event) => event.type === "start" && event.version === nextVersion,
        );
        const published = events.findIndex(
          (event) =>
            event.type === "version" &&
            event.version === nextVersion &&
            event.runner?.includes(`T3_ARCHIVE_VERSION='${nextVersion}'`),
        );
        assert.isAtLeast(verified, 0);
        assert.include(events[verified]!.runner!, `T3_ARCHIVE_VERSION='${oldVersion}'`);
        assert.isTrue(events[verified]!.oldAlive);
        assert.isTrue(events[published]!.oldAlive);
        assert.isBelow(verified, published);
        assert.isBelow(published, stopped);
        assert.isBelow(verified, stopped);
        assert.isBelow(stopped, started);
        assert.include(events[started]!.installed!, `T3_ARCHIVE_VERSION='${nextVersion}'`);
        assert.equal(events[started]!.complete, nextVersion);
        assert.equal(Number(yield* f.oldProcess!.exitCode), 0);
        const resultJson = JSON.parse(result.stdout.trim()) as { serverKind: string };
        assert.equal(resultJson.serverKind, "managed");
        const after = yield* f.snapshot;
        for (const key of [
          "oldExecutable",
          "oldMarker",
          "oldMetadata:goat",
          "oldMetadata:.install-complete",
          "upstreamExecutable",
          "upstreamMarker",
        ])
          assert.deepEqual(after[key], before[key]);
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("identical runner retains managed PID even with its default descriptor", () =>
      Effect.gen(function* () {
        const f = yield* fixture("none", { identical: true });
        const before = yield* f.snapshot;
        const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(yield* f.snapshot, before);
        assert.isTrue(yield* f.oldProcess!.isRunning);
        assert.deepEqual(
          (yield* f.events)
            .filter((event) => event.type === "start" || event.type === "stop")
            .map((event) => event.type),
          ["start"],
        );
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "keep-existing ignores a newer unavailable release and leaves the older runtime untouched",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture("missing-release");
          const before = yield* f.snapshot;
          const scripts = yield* nativeScripts({ ...f.runner, keepExistingRunner: true });
          const result = yield* shell(f.home, scripts.launch, [stateKey]);
          assert.equal(result.code, 0, result.stderr);
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.version === nextVersion));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["pairing", "mcp"] as const)(
      "warm %s uses the retained runner even without a keep flag",
      (entry) =>
        Effect.gen(function* () {
          const f = yield* fixture("missing-release");
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.equal(result.code, 0, result.stderr);
          if (entry === "pairing") {
            assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
          } else {
            assert.deepEqual(yield* SshTunnel.decodeRemoteMcpSessionOutput(result.stdout), {
              token: "fixture-session",
              expiresAt: null,
              runtimeModeCeilingApplied: false,
            });
          }
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.deepEqual(
            (yield* f.events)
              .filter((event) => event.type === "auth")
              .map((event) => event.version),
            [oldVersion],
          );
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["pairing", "mcp"] as const)(
      "cold %s verifies and publishes before issuing credentials",
      (entry) =>
        Effect.gen(function* () {
          const f = yield* fixture("none", { seed: false });
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.equal(result.code, 0, result.stderr);
          if (entry === "pairing") {
            assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
          } else {
            assert.deepEqual(yield* SshTunnel.decodeRemoteMcpSessionOutput(result.stdout), {
              token: "fixture-session",
              expiresAt: null,
              runtimeModeCeilingApplied: false,
            });
          }
          const events = yield* f.events;
          const verified = events.findIndex((event) => event.type === "version");
          const issued = events.findIndex((event) => event.type === "auth");
          assert.isAtLeast(verified, 0);
          assert.isBelow(verified, issued);
          assert.include(
            yield* f.fs.readFileString(`${f.state}/run-t3.sh`),
            `T3_ARCHIVE_VERSION='${nextVersion}'`,
          );
          assert.equal(
            (yield* f.fs.readFileString(
              `${f.home}/.goat/runtime/goat/versions/${nextVersion}/.install-complete`,
            )).trim(),
            nextVersion,
          );
          assert.isFalse(yield* f.fs.exists(`${f.state}/pid`));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      { entry: "pairing", failure: "missing-release" },
      { entry: "pairing", failure: "bad-checksum" },
      { entry: "pairing", failure: "broken-executable" },
      { entry: "pairing", failure: "wrong-version" },
      { entry: "mcp", failure: "missing-release" },
      { entry: "mcp", failure: "bad-checksum" },
      { entry: "mcp", failure: "broken-executable" },
      { entry: "mcp", failure: "wrong-version" },
    ] as const)(
      "cold $entry refuses $failure without publishing or issuing credentials",
      ({ entry, failure }) =>
        Effect.gen(function* () {
          const f = yield* fixture(failure, { seed: false });
          const before = yield* f.snapshot;
          const result = yield* shell(f.home, f.scripts[entry]);
          assert.notEqual(result.code, 0);
          assert.include(result.stderr, nextVersion);
          assert.include(result.stderr, "existing runner and server");
          assert.deepEqual(yield* f.snapshot, before);
          for (const file of ["run-t3.sh", "pid", "port", "managed"]) {
            assert.isFalse(yield* f.fs.exists(`${f.state}/${file}`));
          }
          assert.isFalse(
            (yield* f.events).some((event) => event.type === "auth" || event.type === "start"),
          );
          if (failure === "wrong-version") {
            assert.include(result.stderr, `expected goat v${nextVersion}`);
            assert.include(result.stderr, `reported "goat v${oldVersion}"`);
          } else {
            assert.isFalse(
              yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/${nextVersion}`),
            );
          }
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live(
      "TERM during candidate validation removes the candidate and preserves the old server",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture("none");
          const before = yield* f.snapshot;
          const candidateRuntime = `${f.home}/.goat/runtime/goat/versions/${nextVersion}`;
          yield* f.fs.makeDirectory(candidateRuntime, { recursive: true });
          yield* f.fs.writeFileString(`${candidateRuntime}/.install-complete`, `${nextVersion}\n`);
          yield* f.fs.writeFileString(
            `${candidateRuntime}/goat`,
            `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.HOME + "/.test/events", JSON.stringify({ type: "interrupted-validation", version: ${JSON.stringify(nextVersion)} }) + "\\n");
process.kill(process.ppid, "SIGTERM");
process.exit(95);
`,
          );
          yield* f.fs.chmod(`${candidateRuntime}/goat`, 0o700);
          const result = yield* shell(f.home, f.scripts.launch, [stateKey]);
          assert.notEqual(result.code, 0);
          assert.isTrue((yield* f.events).some((event) => event.type === "interrupted-validation"));
          assert.deepEqual(yield* f.snapshot, before);
          assert.isTrue(yield* f.oldProcess!.isRunning);
          assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
          yield* f.cleanCandidates;
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
```

The installed `@effect/vitest/dist/index.d.ts:60-72` exposes `each` only on `Tester`; both `each(...)` and `skipIf(...)` return callables without the other modifier. The suite-level `describe.skipIf` above avoids unsupported modifier chaining. The snapshots include runner and old-runtime inode/mode/mtime, runtime descriptor bytes and an isolated upstream sentinel. The wrong-version archive is valid/checksummed and its executable exits 0: this activates equality refusal rather than the existing execution failure. The existing archive installer may already have cached the requested-version directory before the candidate-runner equality check; this amendment does not promise rollback of that new cache. It preserves the distinct old runtime, installed runner bytes/metadata, `pid`/`port`/`managed`, descriptor, and old live process. A retry must supply corrected bytes and invalidate that unusable requested-version cache; the error names the archive source and rejected cache path, with cleanup performed through its owning client. Cache hardening is a separate amendment if the parent requires it. Atime is intentionally excluded because execution can update it. TERM tests preinstall the candidate so its executable's parent is the captured generated launch shell; no searched PID is signaled.

### 3.3 Stale-forward recovery: manager behavior, no real SSH

Insert this new test inside the first `describe("ssh tunnel scripts", ...)`, before the existing shutdown/reconnect tests. Use the existing process/net/client fakes and TestClock, and **default** manager shutdown behavior so `leaveRemoteServerRunning` does not mask the bug:

```ts
it.effect.each(["successful reconnect", "failed reconnect"] as const)(
  "stale local forward never stops the remote during %s",
  (mode) =>
    Effect.gen(function* () {
      let forwards = 0;
      let kills = 0;
      let launches = 0;
      let stops = 0;
      let remoteRunning = true;
      let stale = false;
      const probeStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-G"))
            return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
          if (args.includes("-N")) {
            forwards++;
            return makeRunningProcess(() => {
              kills++;
            });
          }
          if (args.includes("--")) {
            launches++;
            if (launches === 2 && mode === "failed reconnect")
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(encoder.encode("Cannot prepare requested GOAT version")),
              };
            stale = false;
            return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}');
          }
          if (args.includes("sh")) {
            stops++;
            remoteRunning = false;
            return makeSuccessfulProcess('{"stopped":true}');
          }
          return makeSuccessfulProcess("");
        }),
      );
      const client = HttpClient.make((request) =>
        stale
          ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        stale = true;
        const reconnect = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(uploadTarget)),
        );
        yield* Deferred.await(probeStarted);
        yield* TestClock.adjust(Duration.seconds(2));
        const result = yield* Fiber.join(reconnect);
        assert.equal(kills, 1);
        assert.equal(stops, 0);
        assert.isTrue(remoteRunning);
        assert.equal(forwards, mode === "successful reconnect" ? 2 : 1);
        assert.equal(launches, 2);
        assert.equal(Result.isSuccess(result), mode === "successful reconnect");
        // Disconnect remains an explicit remote-stop operation, including
        // when reconnection failed and no map entry remains.
        yield* manager.disconnectEnvironment(uploadTarget);
        assert.equal(stops, 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
      assert.equal(stops, 1);
    }),
);
```

A running remote is modeled independently from the local forward; incrementing `stops` is the externally observable stop request. The real-shell same-runner case in §3.2 proves the associated remote process also survives normal reuse; the manager test proves stale map/scope ownership. Keep existing explicit-disconnect failure propagation and Deferred shutdown ordering tests unchanged.

### 3.4 Nested lock-owner PID and Node dev version exemption

Insert these tests inside the §3.2 POSIX suite after `fixture`. The downloader hook runs while the install lock exists and records both its owner file and the hook's actual parent shell PID. It copies the tiny `file://` fixture; no network or timing wait is needed. `shell` accepts the optional `pathValue` shown in §3.2 so only this test uses the hook.

```ts
it.live("a nested auth runner publishes the real shell PID as install-lock owner", () =>
  Effect.gen(function* () {
    const f = yield* fixture("none", { seed: false });
    const bin = `${f.home}/.test/bin`;
    const observed = `${f.home}/.test/lock-owners.jsonl`;
    yield* f.fs.makeDirectory(bin, { recursive: true });
    yield* f.fs.writeFileString(observed, "");
    yield* f.fs.writeFileString(
      `${bin}/curl`,
      `#!${process.execPath}
const fs = require("node:fs");
const { fileURLToPath } = require("node:url");
const home = process.env.HOME;
const lock = home + "/.goat/runtime/goat/versions/.${nextVersion}.install.lock";
const owner = fs.readFileSync(lock + "/pid", "utf8").trim();
let alive = false;
try { process.kill(Number(owner), 0); alive = true; } catch {}
fs.appendFileSync(home + "/.test/lock-owners.jsonl",
  JSON.stringify({ owner, shellPid: process.ppid, alive }) + "\\n");
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith("file://"));
const output = args[args.indexOf("-o") + 1];
fs.copyFileSync(fileURLToPath(url), output);
`,
    );
    yield* f.fs.chmod(`${bin}/curl`, 0o700);
    const result = yield* shell(f.home, f.scripts.pairing, [], `${bin}:${process.env.PATH ?? ""}`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).credential, "fixture-pairing");
    const records = (yield* f.fs.readFileString(observed))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { owner: string; shellPid: number; alive: boolean });
    assert.equal(records.length, 2); // checksum and archive downloads
    for (const record of records) {
      assert.match(record.owner, /^[1-9][0-9]*$/);
      assert.equal(Number(record.owner), record.shellPid);
      assert.isTrue(record.alive);
    }
    assert.equal(records[0]!.owner, records[1]!.owner);
    assert.isFalse(
      yield* f.fs.exists(`${f.home}/.goat/runtime/goat/versions/.${nextVersion}.install.lock`),
    );
    yield* f.cleanCandidates;
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("a Node dev runner succeeds without matching an archive version", () =>
  Effect.gen(function* () {
    const f = yield* fixture("missing-release", { seed: false });
    const devScript = `${f.home}/.test/dev.mjs`;
    yield* f.fs.writeFileString(
      devScript,
      `
if (process.argv[2] === "--version") console.log("dev build without archive version");
else if (process.argv[2] === "auth") console.log(JSON.stringify({ credential: "dev-pairing" }));
else process.exit(2);
`,
    );
    // Even if the input carries an archive version, nodeScriptPath selects dev mode.
    const generated = yield* nativeScripts({ ...ARCHIVE, nodeScriptPath: devScript });
    const result = yield* shell(f.home, generated.pairing);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).credential, "dev-pairing");
    assert.include(yield* f.fs.readFileString(`${f.state}/run-t3.sh`), devScript);
    assert.isFalse(yield* f.fs.exists(`${f.state}/pid`));
    yield* f.cleanCandidates;
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
```

The existing standalone-runner/upload race and stale-lock tests remain required. They complement the new nested lock-PID test, whose equality/aliveness assertions catch the string-replacement bug directly without sleeps or lock-reclaim polling.

### 3.5 Disconnect and shutdown preserve the non-owner remote PID

Insert this matrix inside the §3.2 POSIX suite after `fixture`. The fixture launches a real loopback HTTP server and captures its child handle/PID. Only SSH protocol/forwarding is faked: the stop-request double terminates that captured server and awaits its exit, making an accidental remote stop observable as a dead process. Shutdown means closing the manager's provision scope; the outer fixture scope remains open until all assertions finish.

```ts
it.live.each([
  { leaveRemoteServerRunning: true, action: "disconnect" },
  { leaveRemoteServerRunning: false, action: "disconnect" },
  { leaveRemoteServerRunning: true, action: "shutdown" },
  { leaveRemoteServerRunning: false, action: "shutdown" },
] as const)(
  "$action follows leaveRemoteServerRunning=$leaveRemoteServerRunning",
  ({ leaveRemoteServerRunning, action }) =>
    Effect.gen(function* () {
      const f = yield* fixture("none");
      const before = yield* f.snapshot;
      const remote = f.oldProcess!;
      let forwardKills = 0;
      let remoteStops = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-G")) {
            return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
          }
          if (args.includes("-N"))
            return makeRunningProcess(() => {
              forwardKills++;
            });
          if (args.includes("--")) {
            return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}');
          }
          if (args.includes("sh")) {
            remoteStops++;
            assert.equal(forwardKills, 1); // local forward closes before remote stop
            yield* remote.kill({ killSignal: "SIGTERM" });
            assert.equal(Number(yield* remote.exitCode), 0);
            return makeSuccessfulProcess('{"stopped":true}');
          }
          return makeSuccessfulProcess("");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE),
          ...(leaveRemoteServerRunning ? { leaveRemoteServerRunning: true } : {}),
        }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        assert.isTrue(yield* remote.isRunning);
        if (action === "disconnect") {
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.equal(forwardKills, 1);
          assert.equal(remoteStops, leaveRemoteServerRunning ? 0 : 1);
          assert.equal(yield* remote.isRunning, leaveRemoteServerRunning);
          if (leaveRemoteServerRunning) {
            assert.deepEqual(yield* f.snapshot, before);
            // No cached tunnel remains: a second disconnect still cannot stop it.
            yield* manager.disconnectEnvironment(uploadTarget);
            assert.equal(remoteStops, 0);
            assert.equal(forwardKills, 1);
            assert.isTrue(yield* remote.isRunning);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
      // In shutdown rows the manager finalizer performed the tested action.
      // In disconnect rows it must not perform a duplicate close/remote stop.
      assert.equal(forwardKills, 1);
      assert.equal(remoteStops, leaveRemoteServerRunning ? 0 : 1);
      assert.equal(yield* remote.isRunning, leaveRemoteServerRunning);
      if (leaveRemoteServerRunning) {
        assert.deepEqual(yield* f.snapshot, before);
        assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
      } else {
        assert.equal((yield* f.events).filter((event) => event.type === "stop").length, 1);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
```

Owner rows omit the option, matching desktop rather than passing an explicit false. Non-owner rows use the true value supplied by server dispatch. Keep the existing explicit-stop failure propagation/retry and Deferred shutdown/reconnect ordering tests unchanged; those preserve today's owner error and serialization semantics. No real SSH, live runtime, database or app/browser is involved.

## 4. Relevant MCP test repair (`packages/ssh/src/tunnel.mcpSession.test.ts`)

Change the fixture's GOAT paths, with exact hunks:

```diff
-    const stateDirectory = NodePath.join(home, ".t3", "ssh-launch", stateKey);
+    const stateDirectory = NodePath.join(home, ".goat", "ssh-launch", stateKey);
@@
-  const baseArgs = () => expectedArgs.map((arg) => (arg === "" ? NodePath.join(home, ".t3") : arg));
+  const baseArgs = () => expectedArgs.map((arg) => (arg === "" ? NodePath.join(home, ".goat") : arg));
```

Replace the entire final test that starts with `"replaces an existing runner when keepExistingRunner is false and uses the pinned runtime"`. Before: it installs `.t3/runtime/versions/0.0.45/t3`, expects a replacement token and asserts runner bytes changed. After:

```ts
it.effect("retains the installed runner even when keepExistingRunner is false", () =>
  Effect.gen(function* () {
    const originalRunner = installFakeRunner(false);
    expect(yield* runSession(false)).toEqual({
      token,
      expiresAt,
      runtimeModeCeilingApplied: true,
    });
    expect(NodeFS.readFileSync(runner, "utf8")).toBe(originalRunner);
    expect(receivedArgs(1)).toEqual([
      ...baseArgs(),
      "--runtime-mode-ceiling",
      options.runtimeModeCeiling,
    ]);
    expect(() => receivedArgs(2)).toThrow();
    expect(NodeFS.existsSync(NodePath.join(home, ".goat", "runtime"))).toBe(false);
  }),
);
```

This warm fixture does not respond to `--version`; that is intentional. An existing auth runner is executed directly, and no candidate validation/acquisition should occur. Cold validation is covered by §3.2. Do not remove the older-CLI ceiling fallback test.

## 5. Frozen fixture amendment, not an automatic acceptance update

`remote-runner-baseline.json` has top-level `archive`, `mirror`, `node`, each with `runner`, `launch`, `pairing`. The standalone runner's persisted bytes and upload transformation remain unchanged. The literal function replacer repairs nested runner `$$` in every wrapper (including the archive fallback inside Node-mode runners), while the shared setup adds candidate PID staging and archive-version equality. The exact changing fixture entries are:

| Fixture entry     | Deliberate byte changes                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `archive.launch`  | Literal nested installer lock PID; shared candidate staging/expected archive version; own-runtime reuse branch.                    |
| `archive.pairing` | Literal nested installer lock PID; shared staging/expected version with auth keep mode.                                            |
| `mirror.launch`   | Same launch changes, retaining its explicit mirror URL.                                                                            |
| `mirror.pairing`  | Same pairing changes, retaining its explicit mirror URL.                                                                           |
| `node.launch`     | Literal nested fallback lock PID; shared candidate `run-t3.next.$$`; empty expected version for Node dev mode; own-runtime branch. |
| `node.pairing`    | Literal nested fallback lock PID; shared staging/auth keep mode; empty expected version for Node dev mode.                         |

`archive.runner`, `mirror.runner`, and `node.runner` remain frozen: their lock PID was already literal because it lives in the outer template, not an inserted replacement. Review both the nested lock line and candidate PID line in the six changed wrappers. MCP also receives the corrected generation, but no MCP fixture entry exists and none is added.

After source changes and BEFORE running the baseline test, the parent may execute this deliberate regeneration from the source root. It fails if any runner bytes change or a different set of entries changes. Native Node preserves the same unbundled serialization convention as `nativeScripts`.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
node --input-type=module <<'NODE'
import * as fs from "node:fs";
import assert from "node:assert/strict";
import * as tunnel from "./packages/ssh/src/tunnel.ts";
const file = "packages/ssh/src/fixtures/remote-runner-baseline.json";
const before = JSON.parse(fs.readFileSync(file, "utf8"));
const inputs = {
  archive: { archiveVersion: "1.2.3-preview.20260911.4" },
  mirror: { archiveVersion: "1.2.3-preview.20260911.4", releaseBaseUrl: "https://example.invalid/mirror/" },
  node: { nodeScriptPath: "/fixture/cli entry.mjs", nodeEngineRange: "^22.16 || ^23.11 || >=24.10" },
};
const changed = [];
for (const [key, input] of Object.entries(inputs)) {
  assert.equal(tunnel.buildRemoteT3RunnerScript(input), before[key].runner, `${key}.runner is frozen`);
  const next = {
    launch: tunnel.buildRemoteLaunchScript(input),
    pairing: tunnel.buildRemotePairingScript("711bc738002d72fd", input),
  };
  for (const [field, value] of Object.entries(next)) {
    if (before[key][field] !== value) changed.push(`${key}.${field}`);
    before[key][field] = value;
  }
}
assert.deepEqual(changed.sort(), [
  "archive.launch", "archive.pairing", "mirror.launch", "mirror.pairing", "node.launch", "node.pairing",
].sort());
fs.writeFileSync(file, JSON.stringify(before, null, 2) + "\n");
console.log(`Deliberately updated ${changed.join(", ")}; all runner fields unchanged.`);
NODE
```

Fixture review must check the expanded shell at the six entries. Passing a newly regenerated fixture alone is not behavioral proof. Do not change checksums or fixture input versions to make a failure disappear. `buildRemoteT3UploadInstallerScript` requires its start/end anchors to occur exactly once in the runner, and the existing tests compare its unchanged prefix/suffix against that runner.

## 6. Activation and acceptance ledger

| Activation                                                                                           | Observable acceptance                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requested release directory missing                                                                  | Launch fails naming exact requested version; old runner/runtime/ownership snapshots equal; old HTTP process alive; no stop event; candidate absent.                                                                                                                                                                               |
| SHA256SUMS wrong                                                                                     | Same preservation; checksum diagnostic survives in stderr; no requested completed runtime.                                                                                                                                                                                                                                        |
| Executable exits nonzero on `--version`                                                              | Same preservation; executable-host diagnostic names version; no ready marker/publication.                                                                                                                                                                                                                                         |
| Valid archive executable exits 0 but reports the old/wrong version (with/without default descriptor) | Nonzero launch exit; error names requested and reported versions plus corrective archive action; installed runner bytes/metadata, old runtime, ownership files and descriptor equal; actual old process alive; zero stops; candidate removed. A newly cached requested-version directory may exist and is not old-state rollback. |
| Cold pairing/MCP executable exits 0 but reports wrong version                                        | Nonzero exit before publication/auth; no installed runner/ownership/auth event; exact-version diagnostic; candidate removed.                                                                                                                                                                                                      |
| Node-script dev executable reports an unrelated dev version with exit 0                              | Cold auth runner publishes and returns decoded pairing output; archive-version equality is exempt; no managed server ownership created.                                                                                                                                                                                           |
| Generated archive/mirror/node runner and nested launch/pairing/MCP                                   | Exact nested runner equality; lock-owner `$$` and candidate `run-t3.next.$$` survive; quoted `$$`/`$&` inputs remain literal.                                                                                                                                                                                                     |
| Cold nested archive auth runner with downloader hook                                                 | Lock owner is numeric, equals downloader parent shell PID and is alive at both downloads; installation/auth succeeds; lock and candidate removed. Existing upload/runner race tests continue to pass.                                                                                                                             |
| Candidate receives TERM during validation                                                            | Scoped launch shell exits; EXIT cleanup removes next file; old process/snapshots preserved. SIGKILL explicitly excluded from trap guarantee.                                                                                                                                                                                      |
| Changed valid archive, managed server, default descriptor belongs to same PID                        | Candidate validation observes the old installed runner and live old PID; old stop precedes new start; new start observes published candidate and ready marker.                                                                                                                                                                    |
| Same bytes, default descriptor belongs to managed PID                                                | Same PID/ownership/runner metadata, one initial start, zero stops, no restart.                                                                                                                                                                                                                                                    |
| Keep-existing older valid runner, newer release unavailable                                          | No newer-version invocation/acquisition; old runtime/runner/ownership unchanged and live PID reused.                                                                                                                                                                                                                              |
| Retained runtime missing/invalid/marker-only/wrong marker/non-executable/upstream-only               | Preparation refuses without cache acquisition, runner mutation, auth invocation or stop; error explains retained version/owner and requested version.                                                                                                                                                                             |
| Pairing/MCP warm with default/false flag                                                             | Retained CLI issues credential/session; no runtime acquisition/publication, no restart. Existing ceiling accepted/rejected/null outcomes remain correct.                                                                                                                                                                          |
| Pairing/MCP cold, valid archive                                                                      | Version validation precedes auth; runner published executable, runtime marker correct, auth output decoded; no server launched as an auth side effect.                                                                                                                                                                            |
| Pairing/MCP cold, any installation failure                                                           | No runner or auth output, no server ownership records; candidate cleaned; actionable requested-version message.                                                                                                                                                                                                                   |
| Local-cache size/checksum/gh error                                                                   | Error includes requested version; runner/server untouched; upload authentication still retries once via existing prompt test.                                                                                                                                                                                                     |
| Stale forward, successful reconnect                                                                  | Old forward killed exactly once; no remote stop; normal same-runner launch creates second forward; explicit disconnect still stops once.                                                                                                                                                                                          |
| Stale forward, failed reconnect                                                                      | Old forward removed/closed; no remote stop and no second forward; owner explicit disconnect can still stop the preserved remote.                                                                                                                                                                                                  |
| Non-owner (`leaveRemoteServerRunning: true`) explicit disconnect, then repeat without cached entry   | Local forward killed once, zero remote stop requests, actual remote PID remains alive, installed runner and ownership/descriptor snapshots equal; later scope shutdown does not issue a duplicate stop.                                                                                                                           |
| Owner/default explicit disconnect                                                                    | Local forward killed before one remote stop; actual remote exits and stop event recorded; scope shutdown adds no second stop; existing stop errors still reach caller.                                                                                                                                                            |
| Non-owner manager scope shutdown                                                                     | Local forward killed once; zero remote stops; actual PID and ownership snapshots preserved.                                                                                                                                                                                                                                       |
| Owner/default manager scope shutdown                                                                 | Local forward killed before one remote stop; actual remote exits; finalizer still uses existing best-effort error policy.                                                                                                                                                                                                         |

Boundaries: the shell candidate check is an E7 application boundary implemented by generated shell, not a host security enforcement layer. A caller can invoke the CLI/kill the remote directly; two independent clients can race a runner switch. Residual risk is stated, and no wording claims unbypassable enforcement. There is no additional final enforcement layer in this unit.

## 7. Exact future verification commands and coverage

All commands below are for the **parent implementation**, not this plan leaf. Run only focused suites/targeted typechecks. Do not run a repo-wide check, install, build, SSH command or browser. Each command is **NOT RUN here (scope restriction)**; the source root contains the package scripts/configs. `packages/ssh/package.json` test script is `vp test run --config ../../vite.config.ts --dir .`; its tsconfig includes `src`. `apps/server/vite.config.ts` merges the root config and owns its setup/sequencer; run its consumer regression from that package using its own config.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh
../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/tunnel.test.ts src/tunnel.mcpSession.test.ts
```

Coverage: explicit test paths; both import `tunnel.ts`; frozen fixture is imported by `tunnel.test.ts`; real-shell cases observe executable behavior/files/processes. Capture command, exit status, passed case names and skips. A POSIX skip on Windows is not proof; require a Linux or macOS pass.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server
../../node_modules/.bin/vp test run --config vite.config.ts --dir . src/sshRemote/SshRemoteDispatch.test.ts
```

Coverage: explicit server consumer file imports `@t3tools/ssh/tunnel`; checks dispatch/session compatibility. No server source change is proposed. No orchestration effects added; if a consumer test uses orchestration, retain its existing persisted-event/worker-drain synchronization, never add sleeps.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
./node_modules/.bin/vp exec tsc -p packages/ssh/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p apps/server/tsconfig.json --noEmit
./node_modules/.bin/vp lint packages/ssh/src/tunnel.ts packages/ssh/src/tunnel.test.ts packages/ssh/src/tunnel.mcpSession.test.ts
```

Coverage: SSH `include: ["src"]` includes the changed implementation/tests; server `include: ["src", "vite.config.ts", "scripts", "integration", "../../scripts/lib"]` includes the importing consumer; lint names the three changed TypeScript paths. Typecheck might reveal unrelated pre-existing failures; report actual file/error, never claim a failed command passed. Do not expand into unrelated fixes without parent amendment.

Read-only `rg` structural review gates from the source root (a listing is not behavioral proof):

```sh
rg -n 'replaceAll|EXPECTED_ARCHIVE_VERSION|RUNNER_VERSION_OUTPUT|verify_runner_next|mv "\$RUNNER_NEXT"|RUNNER_CHANGED|REPLACE_OWN_RUNTIME_CHECK' packages/ssh/src/tunnel.ts
rg -n 'prepareRemoteRuntime\(target|keepExistingRunner: true|T3_RUNNER_SETUP' packages/ssh/src/tunnel.ts
rg -n 'tunnels.delete\(key\)|closeTunnelEntry\(entry\)|leaveRemoteServerRunning|stopRemoteServer' packages/ssh/src/tunnel.ts
rg -n 'startAnchor|endAnchor|acquisition block no longer matches' packages/ssh/src/tunnel.ts
rg -n 'wrong-version|shell PID|Node dev runner|leaveRemoteServerRunning|missing-release|bad-checksum|broken-executable|stale local forward|cold .*verifies|identical runner' packages/ssh/src/tunnel.test.ts
```

Expected exits: 0 for these positive listings. Reviewer must inspect context to confirm literal function replacement, candidate execution and exact archive-version equality dominate rename/stop, Node equality exemption, auth retention, stale deletion before close, non-owner explicit disconnect guard, unchanged owner/shutdown policy, and unchanged upload anchors. `rg` alone does not prove ordering.

Forbidden-pattern gates (expected `rg` exit **1**, meaning no match; exit 2 is a tool/error failure):

```sh
rg -n 'cat >"\$RUNNER_FILE"|chmod 700 "\$RUNNER_FILE"|T3_KEEP_EXISTING_RUNNER' packages/ssh/src/tunnel.ts
rg -n 'NodePath.join\(home, "\.t3"' packages/ssh/src/tunnel.mcpSession.test.ts
```

Independent review checks the six fixture fields including nested `$$`, actual installer lock-owner PID, wrong-version exit-zero preservation, Node equality exemption, real remote-PID disconnect/shutdown matrix, real-shell failures with old process alive, successful ordering, own-default descriptor coverage, stale reconnect failure, auth fallback and retained-runtime refusal. Do not call READY from plan/lint/fixture evidence alone. Parent owns exact-head CI/live dispatch in later work phases.

## 8. Risks, limitations and suggested amendments to `000_plan.md`

1. **D1 own-default descriptor:** add “An unchanged runner must keep the managed PID when `server-runtime.json` describes that same PID.” Existing code can restart it independently of `RUNNER_CHANGED`.
2. **D1 auth policy:** make “prefer existing” precise: pairing and MCP always retain an installed runner, even when the caller passes false/default; only cold hosts publish a verified candidate. Propagate state key and derived keep flag into preparation. Missing retained runtime stays an actionable refusal, not an instruction for code to remove it.
3. **D1 stale scope:** qualify “never stops the remote server” as “stale-forward scope closure never issues remote stop”; normal later launch can still perform a separately requested, verified upgrade. The same-runner reconnect acceptance keeps the remote alive end to end.
4. **D1 fixture:** list the six deliberate baseline changes, including literal nested shell PIDs and shared expected-version setup, and require runner fields/upload anchors to remain frozen. The MCP unit test still carries `.t3` fixture paths and replacement expectations; its repair is part of this same behavior slice.
5. **D1 preservation bounds:** failed preparation preserves the previous runtime and managed state; temporary requested-version staging/lock artifacts are cleaned by the existing installer and runner-next by this phase. No rollback after successful publication/new-server launch failure is promised by D1. User action to remove a retained runner, SIGKILL cleanup, and concurrent client switch serialization are outside this phase. Printed archive-version equality is required before publishing any new runner; dev Node-script runners are exempt from equality only.
6. **D4 handoff:** retaining an archive runner while the caller requests Node mode (or the reverse) still needs selected-runner/mode propagation, owned/external compatibility policy and protocol checks in `040_protocol_reuse.md`. Do not claim cross-version/protocol safety from D1's executable/version-equality check alone. This plan does not introduce the protocol fields D4 owns.
7. **D9:** keep pending local packaged-home decision as a wp3/wp5 prerequisite; it does not block this remote SSH package slice. Do not copy `.t3` data during wp1.

The plan writer/amender changed only this named document. No source edits, tests, builds, git, SSH, child dispatch, goal or FSM calls were performed. All added test code and commands are implementation instructions, not claimed execution evidence. The parent must revalidate hunks against shared-source movement before implementation and record the actual verification results.

## Reflection fold (A1)

- Disconnect blocker is folded into §2.6/§3.5: server dispatch disconnect/shutdown is local-only; desktop owner disconnect and shutdown retain today's stop behavior. Tests use a real captured remote PID and include repeated disconnect with no local entry.
- Placeholder blocker is folded into §2.0/§3.1/§3.4/§5: function replacement preserves shell dollars through nesting; generated lock ownership equals the actual shell PID; regenerate exactly six wrapper fields.
- Expected-version blocker is folded into §2.1/§2.3/§3.2/§3.4: exit-zero/wrong-version archives cannot publish a runner or stop the old server; snapshot ownership/runner/old-runtime preservation; Node dev equality exemption is explicit.
- Version directory: the runner only removes/replaces `versions/<v>` for the requested version when it is not ready (missing marker or broken binary); an old runner selects a different version directory, which is never touched. A same-version broken install is replaced only after the new staging verifies. Add a test: failed candidate for version B leaves version A directory and its server intact.

## Audit fold (cycle 1)

Existing managed-reuse fixture (packages/ssh/src/tunnel.test.ts ~1100) writes the retained runner without chmod; add `yield* fs.chmod(\`${state}/run-t3.sh\`, 0o700)` right after writing it, since implicit chmod of retained runners is removed.
