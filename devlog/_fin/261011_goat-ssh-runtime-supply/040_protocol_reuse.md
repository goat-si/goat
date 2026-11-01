Cycle-4 amendment @b79ff462c — executable after-images integrated; baseline before-images: 51/51; in-memory application and unknown-guard reproduction verified.

# 040 — Protocol-compatible SSH runtime selection (D4 / item 3 / wp4)

## Bounded rewrite and loop spec

- Archetype: satisfy-spec; foundations → protocol observation → selection → stage/validate/guard/publish → behavioral proof. Parent owns FSM, goals, integration, architect reflection and independent audit.
- Trigger: audit `01a12892` finding 6 and architect A4, recorded in `002_architect.md`. The earlier plan used pre-item-2 staging anchors; this revision replaces them with the landed shared setup.
- Goal: compatible installed GOAT runtimes survive release skew, with the selected executable used by launch, pairing and MCP; incompatible shared servers remain running with an actionable error.
- Non-goals: source implementation, builds/tests, child dispatch, branch operations, release/publication, desktop identity, packaging or release workflow changes in this leaf.
- Verifier: focused owning-package tests, targeted typechecks and controlled fixture amendment below. **NOT RUN**, explicitly prohibited by the delegation. Source inspection establishes command targets, never exit codes.
- Stop: write this one plan and return summary/line count. Future implementation ends after the acceptance matrix passes and the parent obtains independent final-source review.
- Artifact: this file only. Parent owns source-of-truth updates to `000_plan.md` and the cycle record; no additional working files are authorized here.
- Terminal outcomes: rewritten executable plan, or a concrete source mismatch referred to the parent. Neither outcome is implementation/CI/release evidence.
- Escalation: any change beyond the file map, a conflicting ownership rule, or a baseline hunk altered by concurrent work requires a parent amendment before implementation.

Read-only source root: `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename`, pinned full SHA `b79ff462c140878e0dde164dd91731fac7ada461`. Stale-check HEAD matched; grounding uses `git show b79ff462c:<path>` so concurrent edits cannot alter this plan's baseline. Item 2's staging and literal placeholder substitution and item 1's bundle/cache/gh acquisition are already landed. This revision does not depend on `apps/desktop/src/app/*`, `scripts/build-desktop-artifact.ts`, or release workflows; another agent owns desktop identity.

Architect reference: `002_architect.md`, architect `01a12885-294a`, A4 **AMEND**, accepted by parent: retained-ready is compatibility-gated; inspect a live descriptor; `keepExistingRunner` clients never upgrade a shared server; missing signals permit exact version only. Audit reference: `01a12892`, finding 6, deferred to this rewrite. Parent must send this revision to the same architect and obtain reflection; this leaf does not claim reflection or audit completion.

## Baseline anchors and file map

Stale-check evidence: all 51 contiguous diff before-images in sections 1–8 match `git show b79ff462c:<path>` byte for byte. Whole-block replacement and insertion anchors in sections 2–6 were re-read, including the runtime probe, shared setup/install blocks, setup builder, ownership fragments and launch lifecycle boundaries. Their owning production files are unchanged since 480ed90da; this cycle amends the planned after-images in sections 2–6 and the regression rows in section 8. Two inaccurate source-location labels below were corrected. The planned new shared module and helper test still do not exist at this SHA. Fixture bytes and the listed package configs/test targets are unchanged; this is read-only verification, not build/test proof.

Of the changes since 480ed90da, `packages/ssh/src/tunnel.test.ts` adds an existing `effect/Path` import and the retained-runner ambient-home isolation test at 1576 (`keeps a retained GOAT runner off upstream data despite an ambient T3 home`). Its `nativeScripts` before-images still match at 150. Preserve that import and test when extending the harness; reuse the import if needed. Desktop identity/home, desktop artifact, CLI `app.ts` and desktop-home import changes have no before-images in this unit. Remote runtime paths remain `~/.goat`; desktop profile paths are owned by item 4.

At the pinned SHA, `packages/ssh/src/tunnel.ts` contains:

- `REMOTE_RUNNER_SETUP_SCRIPT` at 618: heredoc candidate, cleanup traps and `verify_runner_next`; install placeholders currently decide whether validation happens.
- `REPLACE_RUNNER_INSTALL` at 823 skips validation for identical bytes; `KEEP_EXISTING_RUNNER_INSTALL` at 832 discards the candidate whenever any runner exists.
- Builders at 974–1045 route launch/pairing/MCP through that shared setup. Own-runtime adoption at 743 uses the two textual `el` fragments; replace the whole adoption decision, not a prefix splice.
- Probe at 1097 and decoder at 1145: installation markers plus an unconditional retained-ready signal. Preparation at 1166 returns void, skips probing explicit mirrors, then has ready → bundle → cache → mirror/gh → upload branches.
- Launch at 1305, pairing at 1367 and MCP at 1430 ignore preparation's result; pairing and MCP already pass `stateKey` and `keepExistingRunner: true`. Do not reintroduce their old missing-state-key bug.
- `SshTunnelEntry` at 116, `startSshTunnel` at 1603, manager pairing at 2206 and manager MCP at 2303 form the selection's remaining in-memory chain.

| Action            | Implementation file                                                             | Change                                                                                                |
| ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| NEW               | `packages/shared/src/sshRuntimeProtocol.ts`                                     | Constant 1; SSH helper/runner/auth compatibility bump policy.                                         |
| MODIFY            | `packages/shared/package.json`                                                  | Explicit subpath export.                                                                              |
| MODIFY            | `packages/contracts/src/environment.ts`, `environment.test.ts`                  | Optional descriptor SSH integer; legacy and malformed decoding.                                       |
| MODIFY            | `apps/server/src/environment/ServerEnvironment.ts`, `ServerEnvironment.test.ts` | Emit current SSH integer alongside version/orchestration.                                             |
| MODIFY            | `apps/server/src/serverRuntimeState.ts`, `serverRuntimeState.test.ts`           | Optional three build fields in format 1; current writer emits all three.                              |
| MODIFY / NEW test | `apps/server/src/cli/sshHelper.ts`, `sshHelper.test.ts`                         | Own JSON advertisement and bounded loopback live observation, including legacy/missing metadata.      |
| MODIFY            | `packages/ssh/src/tunnel.ts`                                                    | Typed selected runtime; read-only compatibility probe; integrated staging/publication and use guards. |
| MODIFY            | `packages/ssh/src/tunnel.test.ts`, `tunnel.mcpSession.test.ts`                  | Isolated-HOME real-shell behavior, manager propagation, existing-double repairs.                      |
| MODIFY            | `packages/ssh/src/fixtures/remote-runner-baseline.json`                         | Six launch/pairing fields only, relative to b79ff462c (unchanged since 480ed90da).                    |
| DELETE            | None                                                                            | Keep old runtime directories and marker data.                                                         |

Field chain: shared SSH constant → service descriptor / format-1 writer / CLI own JSON → contracts schema / persisted schema / shell-token decoder → selector, publication guard, live-server reuse and auth use guard. Server version comes from `apps/server/package.json`; orchestration comes from contracts' existing constant 2. No caller supplies build metadata. Optional fields stay absent on old records; no defaulting to current protocol values.

Selection chain: `prepareRemoteRuntime` → `{runner, version, requestedVersion, source, requireInstalled, mayUpgradeOwnedServer, retainedRunnerSha256}` → launch/pairing/MCP builders → `SshTunnelEntry.selectedRuntime` → manager pairing/MCP. It is memory-only, not a bootstrap/RPC/settings field. Credentials never enter protocol metadata.

All providers are served by the same selected server; no provider adapter changes. Web/desktop/mobile decode the optional descriptor through contracts; existing WS orchestration negotiation remains unchanged. SSH is loopback on the remote in local/tailnet/relay deployments. No DB migration or UI/user-doc change follows from this transport correction. The protocol guard is application logic (E7), executed by generated scripts/helper; manual shell mutation bypasses it and a noncooperating process can race its last check. Call it a compatibility check, not unbypassable enforcement; final enforcement layer: none.

## Compatibility and authority decisions

1. Cross-release selection requires **both explicit integers** equal to the current SSH and orchestration constants, and independently proven candidate version. The running server is a separate observation, fetched from `http://127.0.0.1:<port>/.well-known/t3/environment`.
2. Any advertised incompatible integer rejects, including same-release candidates. Missing integers are not mismatches, but authorize **only exact requested version**, independently proven by `--version` and, for a live server, its descriptor's `serverVersion`. Malformed output is not a missing signal.
3. Persisted fields are corroboration: compare each field that is present to the live descriptor. Missing historical metadata can use the live descriptor as exact-version evidence. Disagreement, malformed state or an answering port without a valid descriptor is unknown, never absence.
4. Prefer a compatible live server's ready executable, then a compatible retained archive, then requested exact acquisition. An incompatible live server cannot be bypassed by choosing a compatible retained executable.
5. Only a launch caller originally lacking `keepExistingRunner` may upgrade an owned server. Ownership requires `managed`, recorded PID equal to the valid live runtime record PID, and a fresh `live` helper observation with reachable descriptor and agreeing persisted PID/port/version. `unknown` never grants publication or termination authority. Pairing/MCP always have `mayUpgradeOwnedServer=false`, including cached selections from owning launch.
6. A compatible managed server keeps its PID/port and ownership even if runner bytes change. An external server is never stopped. A remembered live PID without verified runtime identity fails closed; merely knowing a PID is insufficient restart authority.
7. Ready selections are rechecked before invoking any installing wrapper. Retained selections additionally carry the probe SHA-256 and rehash the source and copied bytes before pinning, publication and use. Their generated candidate is pinned to the selected version; vanished executable/marker errors before publication/auth. A mirror cold selection may install the **requested exact** runtime during candidate validation; preserve the landed acquisition order and archive validation.
8. Explicit Node-script mode remains explicit, uses the configured CLI helper, and never converts a retained Node script into an archive selection. Its build must advertise complete matching protocols; it has no exact archive identity to authorize legacy reuse.

| Activation                                                                           | Observable acceptance                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Older retained/live runtime, SSH=1/orchestration=2                                   | Selected older version; same live PID/port; pairing/MCP log that executable; zero bundle/cache reads, gh, upload, download, stop.                                                    |
| Older retained runtime lacks command or one integer, no live server                  | No cross-release reuse; acquire requested exact; preserve old executable and marker.                                                                                                 |
| Exact ready legacy binary, no live server                                            | `--version` proves exact; permitted when command is absent; no guessed integer.                                                                                                      |
| Exact live descriptor omits protocol fields                                          | Permitted only with matching exact binary version and no explicit mismatch; valid old format-1 metadata remains readable.                                                            |
| Same exact version advertises mismatching integer                                    | Reject before publish; same version does not override a protocol mismatch.                                                                                                           |
| Owned live incompatible, owning launch                                               | Stage and verify requested candidate first; guard approves ownership; publish; fresh identity check; terminate only recorded live owned PID; wait for exit; spawn requested runtime. |
| Owned live incompatible, secondary launch/pairing/MCP                                | Error before runner/process/ownership mutation, regardless of selected runner's keep flag.                                                                                           |
| External live incompatible/unknown or remembered external port with malformed record | Error and preserve state; original captured process continues answering.                                                                                                             |
| Persisted/live descriptor disagree, or nonloopback origin                            | Never select cross-release from those records; externally owned server remains untouched.                                                                                            |
| Owning launch with stale metadata or descriptor 404                                  | Actionable unknown error; no publication/kill; original process and runner/ownership bytes preserved.                                                                                |
| Same-version retained runner replaced between probe and launch/pairing/MCP           | SHA-256 mismatch before copied bytes execute/pin/publish; no auth/start/stop; zero acquisition.                                                                                      |
| Malformed own/live version, protocols or PID/port tokens (also Node mode)            | Reject successful malformed output; valid own `0 0` and independently proven exact-version legacy fallback remain supported.                                                         |
| Selection disappears or retained runner changes after prepare                        | Error before installing wrapper, publish, serve or auth; zero old-release acquisition.                                                                                               |
| Cached manager pairing/MCP after resolver version changes                            | Carry original selection; recheck it/live descriptor; issue with original chosen binary or error, never silently select a different release.                                         |
| MCP ceiling rejected                                                                 | Both attempts use the same selection and fresh guard; preserve fallback semantics and ceiling marker.                                                                                |

## 1. Foundation hunks

NEW `packages/shared/src/sshRuntimeProtocol.ts`:

```ts
/** Bump when helper grammar, runner lifecycle, or auth-state semantics cease to interoperate. */
export const SSH_RUNTIME_PROTOCOL_VERSION = 1;
```

```diff
--- a/packages/shared/package.json
+++ b/packages/shared/package.json
@@
   "exports": {
+    "./sshRuntimeProtocol": {
+      "types": "./src/sshRuntimeProtocol.ts",
+      "import": "./src/sshRuntimeProtocol.ts"
+    },
     "./authScopeOptions": {
--- a/packages/contracts/src/environment.ts
+++ b/packages/contracts/src/environment.ts
@@
   serverVersion: TrimmedNonEmptyString,
+  /** Absent on servers predating SSH runner compatibility advertisement. */
+  sshRuntimeProtocolVersion: Schema.optionalKey(Schema.Int),
   /** Absent on hosts from before explicit orchestration protocol negotiation. */
--- a/apps/server/src/environment/ServerEnvironment.ts
+++ b/apps/server/src/environment/ServerEnvironment.ts
@@
 import * as HostProcess from "@t3tools/shared/HostProcess";
+import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
@@
     serverVersion: packageJson.version,
+    sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
     orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
--- a/apps/server/src/serverRuntimeState.ts
+++ b/apps/server/src/serverRuntimeState.ts
@@
 import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
+import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
+import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
+import packageJson from "../package.json" with { type: "json" };
@@
   version: Schema.Literal(1),
+  serverVersion: Schema.optionalKey(Schema.String),
+  sshRuntimeProtocolVersion: Schema.optionalKey(Schema.Int),
+  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
   pid: Schema.Int,
@@
     version: 1,
+    serverVersion: packageJson.version,
+    sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
+    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
     pid: process.pid,
```

Format version is still 1. Existing startup/service readers keep accepting historical files; `server.ts` already calls the runtime builder and needs no argument or metadata plumbing change. Validate positive safe protocol integers in compatibility observation even though historical schema uses `Schema.Int`.

## 2. CLI protocol and live loopback observation

MODIFY `apps/server/src/cli/sshHelper.ts`: keep existing pick-port/wait-ready/runtime-port behavior. Add imports and register one unlisted helper subcommand:

```diff
 import * as Effect from "effect/Effect";
-import { Argument, Command } from "effect/cli";
+import * as Option from "effect/Option";
+import * as Schema from "effect/Schema";
+import { Argument, Command, Flag } from "effect/cli";
+import { ExecutionEnvironmentDescriptor, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
+import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
+import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
+import packageJson from "../../package.json" with { type: "json" };
@@
-  Command.withSubcommands([pickPort, waitReady, runtimePort]),
+  Command.withSubcommands([pickPort, waitReady, runtimePort, protocol]),
```

Insert this complete block before `export const sshHelperCommand`. The helper uses native Node APIs like its existing neighbors. `protocol` with no flags prints exactly three build fields as JSON. `--shell` is an internal token bridge. `--runtime-file` requests a live observation, never the candidate binary's own signals; `--port-file` and `--pid-file` detect remembered servers when the default record is missing/broken. JSON live output includes status and PID/port; shell live output has six tokens, versus five own tokens.

```ts
export const ownSshRuntimeProtocol = () => ({
  serverVersion: packageJson.version,
  sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
});

const readProtocolDescriptor = (port: number) =>
  new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (cause?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (cause !== undefined) reject(cause);
      else resolve(value);
    };
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path: "/.well-known/t3/environment", timeout: 1000 },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) {
            const cause = new Error("SSH runtime descriptor exceeds 64 KiB");
            response.destroy(cause);
            request.destroy(cause);
            finish(cause);
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", finish);
        response.once("end", () => {
          try {
            if (response.statusCode !== 200) throw new Error("SSH runtime descriptor unavailable");
            // @effect-diagnostics-next-line preferSchemaOverJson:off - validated by caller.
            finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (cause) {
            finish(cause);
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      const cause = new Error("SSH descriptor deadline exceeded");
      request.destroy(cause);
      finish(cause);
    }, 1500);
    request.once("timeout", () => {
      const cause = new Error("SSH descriptor timed out");
      request.destroy(cause);
      finish(cause);
    });
    request.once("error", finish);
  });

const protocolVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
const protocolInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
};
const hasLoopbackListener = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (present: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(present);
    };
    const deadline = setTimeout(() => finish(false), 1000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
const rememberedInteger = (file: string | undefined) => {
  if (file === undefined || !NodeFS.existsSync(file)) return 0;
  const raw = NodeFS.readFileSync(file, "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("Invalid remembered SSH identity");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid remembered SSH identity");
  return value;
};

export const readLiveSshRuntimeProtocol = async (
  runtimeFile: string,
  portFile?: string,
  pidFile?: string,
) => {
  let pid = 0;
  let port = 0;
  let record: typeof PersistedServerRuntimeState.Type | undefined;
  let damaged = false;
  try {
    if (NodeFS.existsSync(runtimeFile)) {
      // @effect-diagnostics-next-line preferSchemaOverJson:off - decoded immediately.
      record = Schema.decodeUnknownSync(PersistedServerRuntimeState)(
        JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")),
      );
      const origin = new URL(record.origin);
      if (
        !Number.isSafeInteger(record.pid) ||
        record.pid <= 0 ||
        !Number.isSafeInteger(record.port) ||
        record.port < 1 ||
        record.port > 65535 ||
        origin.protocol !== "http:" ||
        !["127.0.0.1", "localhost"].includes(origin.hostname) ||
        Number(origin.port || "80") !== record.port
      )
        throw new Error("Invalid runtime identity");
      pid = !record.serviceManaged && processExists(record.pid) ? record.pid : 0;
      port = record.port;
    }
  } catch {
    record = undefined;
    damaged = true;
  }
  let rememberedPid = 0;
  try {
    if (port === 0) port = rememberedInteger(portFile);
    rememberedPid = rememberedInteger(pidFile);
    const rememberedPort = rememberedInteger(portFile);
    if (
      record !== undefined &&
      ((rememberedPort > 0 && rememberedPort !== record.port) ||
        (rememberedPid > 0 && rememberedPid !== record.pid))
    )
      damaged = true;
    if (port > 65535) throw new Error("Invalid remembered port");
  } catch {
    damaged = true;
    port = 0;
  }
  const rememberedAlive = rememberedPid > 0 && processExists(rememberedPid);
  const unknown = { status: "unknown", pid, port } as const;
  if (port === 0)
    return damaged || rememberedAlive ? unknown : ({ status: "none", pid: 0, port: 0 } as const);
  let raw: unknown;
  try {
    raw = await readProtocolDescriptor(port);
  } catch {
    // A root HTTP response or living PID is not compatibility evidence.
    if (damaged || pid > 0 || rememberedAlive || (await hasLoopbackListener(port))) return unknown;
    return { status: "none", pid: 0, port: 0 } as const;
  }
  try {
    const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)(raw);
    if (!protocolVersion(descriptor.serverVersion)) return unknown;
    for (const field of ["sshRuntimeProtocolVersion", "orchestrationProtocolVersion"] as const) {
      const value = descriptor[field];
      if (value !== undefined && !protocolInteger(value)) return unknown;
    }
    if (damaged) return unknown;
    if (record !== undefined) {
      for (const field of [
        "serverVersion",
        "sshRuntimeProtocolVersion",
        "orchestrationProtocolVersion",
      ] as const) {
        // Old format-1 absence is allowed; disagreement with a present field is not.
        if (record[field] !== undefined && record[field] !== descriptor[field]) return unknown;
      }
    }
    // Reread after HTTP: a changed persisted PID/port/version cannot authorize ownership.
    if (record !== undefined) {
      const current = Schema.decodeUnknownSync(PersistedServerRuntimeState)(
        JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")),
      );
      for (const field of [
        "pid",
        "port",
        "origin",
        "startedAt",
        "serviceManaged",
        "serverVersion",
        "sshRuntimeProtocolVersion",
        "orchestrationProtocolVersion",
      ] as const) {
        if (current[field] !== record[field]) return unknown;
      }
      // Historical records still support live exact-version reuse, but do not grant kill authority.
      if (record.serverVersion === undefined || !processExists(record.pid)) pid = 0;
    }
    // No record/dead/unversioned PID means an answering port is external.
    return {
      status: "live",
      pid,
      port,
      serverVersion: descriptor.serverVersion,
      sshRuntimeProtocolVersion: descriptor.sshRuntimeProtocolVersion,
      orchestrationProtocolVersion: descriptor.orchestrationProtocolVersion,
    } as const;
  } catch {
    return unknown;
  }
};

const protocol = Command.make("protocol", {
  shell: Flag.Boolean("shell"),
  runtimeFile: Flag.String("runtime-file").pipe(Flag.optional),
  portFile: Flag.String("port-file").pipe(Flag.optional),
  pidFile: Flag.String("pid-file").pipe(Flag.optional),
}).pipe(
  Command.withHandler(({ shell, runtimeFile, portFile, pidFile }) =>
    Effect.promise(async () => {
      try {
        const signals = Option.isSome(runtimeFile)
          ? await readLiveSshRuntimeProtocol(
              runtimeFile.value,
              Option.getOrUndefined(portFile),
              Option.getOrUndefined(pidFile),
            )
          : ownSshRuntimeProtocol();
        if (!shell) {
          process.stdout.write(JSON.stringify(signals) + "\n");
          return;
        }
        if ("serverVersion" in signals && !protocolVersion(signals.serverVersion)) {
          throw new Error("Invalid SSH protocol version token");
        }
        const version = "serverVersion" in signals ? signals.serverVersion : "unknown";
        const integer = (value: unknown) => (protocolInteger(value) ? String(value) : "unknown");
        const fields = [
          version,
          integer(
            "sshRuntimeProtocolVersion" in signals ? signals.sshRuntimeProtocolVersion : undefined,
          ),
          integer(
            "orchestrationProtocolVersion" in signals
              ? signals.orchestrationProtocolVersion
              : undefined,
          ),
          "pid" in signals ? signals.pid : 0,
          "port" in signals ? signals.port : 0,
        ];
        process.stdout.write(
          ("status" in signals ? signals.status + " " : "") + fields.join(" ") + "\n",
        );
      } catch (cause) {
        process.stderr.write(
          (cause instanceof Error ? cause.message : "Cannot inspect SSH protocol") + "\n",
        );
        process.exitCode = 1;
      }
    }),
  ),
);
```

The observer bounds socket inactivity to 1 second, total descriptor time to 1500 ms and response bytes to 64 KiB. A separate TCP check bounded to 1 second distinguishes a missing listener from an unidentifiable answering port without relying on the legacy root readiness probe. Helper tests use held/trickling/oversized real responses and verify bounded completion; the test itself does not sleep. Collected Buffer chunks preserve split UTF-8 code points.

Legacy command absence may permit **cold exact binary** reuse. If that executable cannot run the live-observation helper and runtime/remembered identity files exist, fail closed; it cannot independently establish an exact live version. An exact legacy descriptor missing only protocol integers is supported by the new observer. Never infer server version from the selected directory alone.

## 3. Selected-runtime type and read-only probe

```diff
--- a/packages/ssh/src/tunnel.ts
+++ b/packages/ssh/src/tunnel.ts
@@
 } from "@t3tools/contracts";
+import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
+import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
@@
 interface SshTunnelEntry {
+  readonly selectedRuntime: PreparedRemoteRuntime;
```

Insert immediately after `RemoteT3RunnerOptions`:

```ts
export interface PreparedRemoteRuntime {
  readonly runner: RemoteT3RunnerOptions;
  readonly version: string | null;
  readonly requestedVersion: string | null;
  readonly source: "requested" | "retained" | "live";
  readonly requireInstalled: boolean;
  readonly mayUpgradeOwnedServer: boolean;
  /** SHA-256 of the retained run-t3.sh observed by preparation; null for other sources. */
  readonly retainedRunnerSha256: string | null;
}
const requestedRuntime = (runner: RemoteT3RunnerOptions | undefined): PreparedRemoteRuntime => ({
  runner: { ...runner },
  version: isNodeScriptRunner(runner) ? null : runner?.archiveVersion?.trim() || null,
  requestedVersion: isNodeScriptRunner(runner) ? null : runner?.archiveVersion?.trim() || null,
  source: "requested",
  requireInstalled: false,
  retainedRunnerSha256: null,
  mayUpgradeOwnedServer: runner?.keepExistingRunner !== true,
});
const RuntimeSignals = Schema.Struct({
  serverVersion: Schema.String,
  sshRuntimeProtocolVersion: Schema.optionalKey(Schema.Int),
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  invalid: Schema.optionalKey(Schema.Boolean),
});
const matchesSignals = (signals: typeof RuntimeSignals.Type, requested: string) =>
  !signals.invalid &&
  ((signals.sshRuntimeProtocolVersion === SSH_RUNTIME_PROTOCOL_VERSION &&
    signals.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) ||
    (signals.serverVersion === requested &&
      (signals.sshRuntimeProtocolVersion === undefined ||
        signals.sshRuntimeProtocolVersion === SSH_RUNTIME_PROTOCOL_VERSION) &&
      (signals.orchestrationProtocolVersion === undefined ||
        signals.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION)));
```

Insert this shared shell block beside the selected-runtime type; both probe and execution scripts embed the same validators and SHA-256 function:

```ts
const REMOTE_PROTOCOL_TOKEN_SCRIPT = `valid_version() {
  printf '%s\\n' "$1" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'
}
valid_uint() {
  printf '%s\\n' "$1" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)$' || return 1
  [ "\${#1}" -le 16 ] && awk -v n="$1" 'BEGIN { exit !(n <= 9007199254740991) }'
}
valid_positive() { valid_uint "$1" && [ "$1" != 0 ]; }
valid_port() { valid_uint "$1" && [ "$1" -le 65535 ]; }
valid_protocol_field() { [ "$1" = unknown ] || valid_positive "$1"; }
valid_own_tokens() {
  [ "$#" = 5 ] && valid_version "$1" && valid_protocol_field "$2" &&
    valid_protocol_field "$3" && valid_uint "$4" && valid_port "$5" || return 1
  # Own advertisement is normally not running: 0 0 is a valid pair.
  { [ "$4" = 0 ] && [ "$5" = 0 ]; } ||
    { valid_positive "$4" && valid_positive "$5"; }
}
valid_live_tokens() {
  [ "$#" = 6 ] && valid_uint "$5" && valid_port "$6" || return 1
  case "$1" in
    live) valid_version "$2" && valid_protocol_field "$3" &&
      valid_protocol_field "$4" && valid_positive "$6" ;;
    none) [ "$2 $3 $4 $5 $6" = 'unknown unknown unknown 0 0' ] ;;
    unknown) [ "$2 $3 $4" = 'unknown unknown unknown' ] ;;
    *) return 1 ;;
  esac
}
runner_sha256() {
  if command -v shasum >/dev/null 2>&1; then digest="$(shasum -a 256 "$1")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$1")" || return 1
  else printf 'Install shasum or sha256sum to verify the retained GOAT runner.\\n' >&2; return 1; fi
  digest="\${digest%% *}"
  printf '%s\\n' "$digest" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s' "$digest"
}
`;
```

Helper token grammar: own is `<exact-semver> <positive-int|unknown> <positive-int|unknown> <pid> <port>` with either `0 0` (not running) or both positive; live is `live <exact-semver> <positive-int|unknown> <positive-int|unknown> <nonnegative-pid> <positive-port>` (PID 0 means external); none is exactly `none unknown unknown unknown 0 0`; unknown is `unknown unknown unknown unknown <nonnegative-pid> <nonnegative-port>`. Integers are canonical safe decimal integers, ports at most 65535. SemVer permits canonical prerelease/build suffixes and rejects leading-zero numeric prerelease identifiers. A successful malformed output is an error, never legacy-command absence. Unknown is an observation state, never a version token where own/live require a version.

Replace `buildRemoteRuntimeProbeScript` completely at its existing function anchor. This implementation executes ready binaries directly, never retained/installing wrappers. Canonical five/six token output is the only shell-to-JSON bridge; malformed success is marked invalid, distinct from an unavailable old command. Version directories are always validated before constructing a path. Existing marker `ready` means installation readiness, not protocol readiness.

```ts
export function buildRemoteRuntimeProbeScript(
  version: string,
  stateKey?: string,
  _keepExistingRunner = false,
): string {
  return `set -eu
V=${shellSingleQuote(version)}
state_key=${shellSingleQuote(stateKey ?? "")}
state="$HOME/.goat/ssh-launch/$state_key"
runtime_file="$HOME/.goat/userdata/server-runtime.json"
${REMOTE_PROTOCOL_TOKEN_SCRIPT}
ready_version() {
  valid_version "$1" && [ -x "$HOME/.goat/runtime/goat/versions/$1/goat" ] &&
    [ "$(cat "$HOME/.goat/runtime/goat/versions/$1/.install-complete" 2>/dev/null)" = "$1" ]
}
signals_json() {
  # Positional parameters are scoped to this function, not the enclosing script.
  version="$1"; ssh="$2"; orch="$3"
  valid_version "$version" || return 1
  fields=
  for pair in "sshRuntimeProtocolVersion:$ssh" "orchestrationProtocolVersion:$orch"; do
    key="\${pair%%:*}"; value="\${pair#*:}"
    if [ "$value" = unknown ]; then continue; fi
    case "$value" in ''|*[!0-9]*) return 1 ;; esac
    valid_positive "$value" || return 1
    fields="$fields,\\\"$key\\\":$value"
  done
  printf '{"serverVersion":"%s"%s}' "$version" "$fields"
}
binary_json() {
  v="$1"; exe="$HOME/.goat/runtime/goat/versions/$v/goat"
  if ! ready_version "$v" || [ "$("$exe" --version 2>/dev/null || true)" != "goat v$v" ]; then return 1; fi
  if own="$("$exe" __ssh-helper protocol --shell 2>/dev/null)"; then
    set -f; set -- $own
    if ! valid_own_tokens "$@" || [ "$1" != "$v" ]; then printf '{"serverVersion":"%s","invalid":true}' "$v"; return; fi
    if signals="$(signals_json "$1" "$2" "$3")"; then printf '%s' "$signals";
    else printf '{"serverVersion":"%s","invalid":true}' "$v"; fi
  else
    # Exact legacy fallback has independent --version evidence above.
    printf '{"serverVersion":"%s"}' "$v"
  fi
}
retained_version=
retained_sha256=
if [ -n "$state_key" ] && [ -f "$state/run-t3.sh" ]; then
  retained_sha256="$(runner_sha256 "$state/run-t3.sh")" || exit 1
  node_path="$(sed -n "s/^T3_NODE_SCRIPT_PATH='\\(.*\\)'$/\\1/p" "$state/run-t3.sh")"
  if [ -z "$node_path" ]; then
    retained_version="$(sed -n "s/^T3_ARCHIVE_VERSION='\\([^']*\\)'$/\\1/p" "$state/run-t3.sh")"
  fi
fi
retained_fields=
if ready_version "$retained_version"; then
  retained_signals="$(binary_json "$retained_version" || true)"
  if [ -n "$retained_signals" ]; then
    [ "$(runner_sha256 "$state/run-t3.sh")" = "$retained_sha256" ] || {
      printf 'Retained GOAT runner changed during probe; reconnect.\\n' >&2; exit 1;
    }
    retained_fields="$(printf ',"retained":"ready","retainedVersion":"%s","retainedSignals":%s,"retainedRunnerSha256":"%s"' "$retained_version" "$retained_signals" "$retained_sha256")"
  fi
fi
# Persisted version is a path hint only. The live descriptor proves identity.
live_hint="$(sed -n 's/.*"serverVersion"[[:space:]]*:[[:space:]]*"\\([^" ]*\\)".*/\\1/p' "$runtime_file" 2>/dev/null || true)"
live_fields=
for candidate in "$live_hint" "$retained_version" "$V"; do
  if ! ready_version "$candidate"; then continue; fi
  exe="$HOME/.goat/runtime/goat/versions/$candidate/goat"
  if live="$("$exe" __ssh-helper protocol --runtime-file "$runtime_file" --port-file "$state/port" --pid-file "$state/pid" --shell 2>/dev/null)"; then
    set -f; set -- $live
    if ! valid_live_tokens "$@"; then
      printf 'Malformed live GOAT protocol tokens; fix the remote helper and reconnect.\\n' >&2; exit 1
    fi
    live_fields="$(printf ',"liveStatus":"%s"' "$1")"
    if [ "$1" = live ] && valid_version "$2"; then
      live_version="$2"
      live_signals="$(signals_json "$2" "$3" "$4" || true)"
      live_binary="$(binary_json "$live_version" || true)"
      if [ -n "$live_signals" ]; then
        live_fields="$live_fields$(printf ',"liveVersion":"%s","liveSignals":%s' "$live_version" "$live_signals")"
        if [ -n "$live_binary" ]; then
          live_fields="$live_fields$(printf ',"liveBinarySignals":%s' "$live_binary")"
        fi
      fi
    fi
    break
  fi
done
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) exit 1 ;; esac
ready=false
if ready_version "$V"; then ready=true; fi
printf '{"platform":"%s","arch":"%s","ready":%s%s%s}\\n' "$platform" "$arch" "$ready" "$retained_fields" "$live_fields"
`;
}
```

Replace the decoder's two retained-only fields, leaving platform/arch/ready:

```diff
       retained: Schema.optionalKey(Schema.Literals(["ready", "missing"])),
       retainedVersion: Schema.optionalKey(Schema.String),
+      retainedSignals: Schema.optionalKey(RuntimeSignals),
+      retainedRunnerSha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
+      liveStatus: Schema.optionalKey(Schema.Literals(["none", "live", "unknown"])),
+      liveVersion: Schema.optionalKey(Schema.String),
+      liveSignals: Schema.optionalKey(RuntimeSignals),
+      liveBinarySignals: Schema.optionalKey(RuntimeSignals),
```

`missing` remains decoder-compatible with old test doubles but grants no authority and has no early return. Retained-ready requires executable version proof and an observed runner SHA-256. Missing fingerprints in old doubles cannot select a retained source. Decimal protocol text is canonical; malformed success is invalid, while unavailable commands retain only independently proven version. `liveStatus` distinguishes absence from live/unknown observations even when no matching executable is installed.

## 4. Preparation integrated with landed acquisition

These are hunks against the current function, including **every return site**. Preserve bundled validation, distinct writable cache, gh downloader, checksum handling, upload installer and annotated acquisition source unchanged.

```diff
@@
   Effect.gen(function* () {
-    const mayRetainRunner = runner?.keepExistingRunner && stateKey !== undefined;
-    if (isNodeScriptRunner(runner) && !mayRetainRunner) return;
+    const exact = requestedRuntime(runner);
+    if (isNodeScriptRunner(runner)) return exact;
@@
-    // Explicit mirrors retain the existing path without a local cache.
-    if (directory === "" && bundleDirectory === "" && mirror !== "" && !mayRetainRunner) return;
+    // Observe a compatible installed runtime before any acquisition, including mirrors.
@@
-    if (probe.retained === "ready") {
-      yield* Effect.annotateCurrentSpan("t3.runtime.source", "retained-runner");
-      return;
-    }
-    if (probe.retained === "missing") {
-      return yield* new SshLaunchError({
-        message: `The retained runner ~/.goat/ssh-launch/${stateKey}/run-t3.sh selects goat ${probe.retainedVersion}, which is not installed on ${target.alias}. This client reuses that runner and will not replace it; reconnect from the client that owns it, or remove the runner to let this client install its own runtime.`,
-        stdout: "",
-      });
-    }
-    if (isNodeScriptRunner(runner)) return;
+    const liveCompatible = probe.liveVersion !== undefined
+      && probe.liveSignals !== undefined && probe.liveBinarySignals !== undefined
+      && probe.liveSignals.serverVersion === probe.liveVersion
+      && probe.liveBinarySignals.serverVersion === probe.liveVersion
+      && matchesSignals(probe.liveSignals, version) && matchesSignals(probe.liveBinarySignals, version);
+    const retainedCompatible = probe.liveStatus === "none"
+      && probe.retained === "ready" && probe.retainedVersion !== undefined
+      && probe.retainedSignals !== undefined && probe.retainedRunnerSha256 !== undefined
+      && probe.retainedSignals.serverVersion === probe.retainedVersion
+      && matchesSignals(probe.retainedSignals, version);
+    const selectedVersion = liveCompatible ? probe.liveVersion
+      : retainedCompatible ? probe.retainedVersion : undefined;
+    if (selectedVersion !== undefined) {
+      const retained = selectedVersion === probe.retainedVersion
+        && probe.retainedSignals !== undefined
+        && probe.retainedSignals.serverVersion === selectedVersion
+        && matchesSignals(probe.retainedSignals, version)
+        && probe.retainedRunnerSha256 !== undefined;
+      yield* Effect.annotateCurrentSpan("t3.runtime.source", retained ? "retained-runner" : "live-runtime");
+      return { ...exact, version: selectedVersion, source: retained ? "retained" : "live",
+        requireInstalled: true, runner: { ...runner, archiveVersion: selectedVersion },
+        retainedRunnerSha256: retained ? probe.retainedRunnerSha256 ?? null : null } satisfies PreparedRemoteRuntime;
+    }
     if (probe.ready) {
       yield* Effect.annotateCurrentSpan("t3.runtime.source", "ready");
-      return;
+      return { ...exact, requireInstalled: true };
@@
       if (mirror !== "") {
         yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
-        return;
+        return exact;
@@
     if (bundledArchive === null && localArchive === null && mirror !== "") {
       yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
-      return;
+      return exact;
@@
     yield* Effect.annotateCurrentSpan("t3.runtime.upload.installComplete", true);
+    return { ...exact, requireInstalled: true };
```

Do not set `keepExistingRunner=false` during fallback: it encodes caller authority and survives every selection. Publication preservation is instead determined by `source === 'retained'`. A live/unknown incompatible observation prevents the dormant retained fallback; an approved owned upgrade therefore always stages the requested exact version, never an unrelated compatible dormant version. This resolves the pre-item-2 ambiguity between retaining bytes, selecting an executable and owning a restart.

A ready requested executable's advertised mismatch can be rejected by the final candidate guard without acquisition. A incompatible/unidentified live server is always checked again in that guard; the preparation probe may select/acquire a candidate but cannot stop/publish. An early error optimization is optional, not a substitute for the pre-publication live guard.

## 5. Integrated stage → validate → guard → publish

Replace the complete landed `REMOTE_RUNNER_SETUP_SCRIPT`, `REPLACE_RUNNER_INSTALL` and `KEEP_EXISTING_RUNNER_INSTALL` with these after-blocks. There is one shared implementation for launch/pairing/MCP. Literal placeholder replacement from item 2 remains intact; do not use string-valued replacement that collapses shell `$$`.

```ts
const REMOTE_RUNNER_SETUP_SCRIPT = `RUNNER_FILE="$STATE_DIR/run-t3.sh"
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
RUNNER_CANDIDATE_FILE="$RUNNER_NEXT"
CHECK_RUNNER="$RUNNER_NEXT"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
REQUESTED_RUNNER=@@T3_REQUESTED_RUNNER@@
EXPECTED_ARCHIVE_VERSION=@@T3_EXPECTED_ARCHIVE_VERSION@@
SELECTED_VERSION=@@T3_SELECTED_VERSION@@
REQUESTED_VERSION=@@T3_REQUESTED_VERSION@@
REQUIRE_INSTALLED=@@T3_REQUIRE_INSTALLED@@
PRESERVE_SELECTED_RUNNER=@@T3_PRESERVE_SELECTED_RUNNER@@
ALLOW_OWNED_UPGRADE=@@T3_ALLOW_OWNED_UPGRADE@@
EXPECTED_RETAINED_SHA256=@@T3_RETAINED_RUNNER_SHA256@@
@@T3_PROTOCOL_TOKENS@@
check_retained_runner() {
  if [ "$PRESERVE_SELECTED_RUNNER" = 1 ]; then
    if [ -z "$EXPECTED_RETAINED_SHA256" ] || [ ! -f "$RUNNER_FILE" ] ||
       [ "$(runner_sha256 "$RUNNER_FILE")" != "$EXPECTED_RETAINED_SHA256" ]; then
      printf 'Selected retained GOAT runner bytes changed since probe; reconnect to prepare again.\\n' >&2; exit 1
    fi
  fi
}
mkdir -p "$STATE_DIR"
cleanup_runner_next() { rm -f "$RUNNER_CANDIDATE_FILE" "$RUNNER_CANDIDATE_FILE.pin"; }
trap cleanup_runner_next EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$REQUIRE_INSTALLED" = 1 ] && [ -n "$SELECTED_VERSION" ]; then
  selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
  if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
    printf 'Selected GOAT %s disappeared; reconnect to prepare again.\\n' "$SELECTED_VERSION" >&2; exit 1
  fi
fi
check_retained_runner
if [ "$PRESERVE_SELECTED_RUNNER" = 1 ]; then
  # Use copied retained bytes and verify the parsed selected version again.
  if [ ! -f "$RUNNER_FILE" ] ||
     [ "$(sed -n "s/^T3_ARCHIVE_VERSION='\\([^']*\\)'$/\\1/p" "$RUNNER_FILE")" != "$SELECTED_VERSION" ] ||
     [ -n "$(sed -n "s/^T3_NODE_SCRIPT_PATH='\\(.*\\)'$/\\1/p" "$RUNNER_FILE")" ]; then
    printf 'Selected retained runner changed; reconnect to prepare again.\\n' >&2; exit 1
  fi
  cp "$RUNNER_FILE" "$RUNNER_NEXT"
else
  cat >"$RUNNER_NEXT" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
fi
chmod 700 "$RUNNER_NEXT"
# Verify copied bytes before executing or pinning, closing a same-version replacement race.
check_retained_runner
if [ "$PRESERVE_SELECTED_RUNNER" = 1 ] &&
   [ "$(runner_sha256 "$RUNNER_NEXT")" != "$EXPECTED_RETAINED_SHA256" ]; then
  printf 'Retained GOAT runner changed while copying; reconnect.\\n' >&2; exit 1
fi
cp "$RUNNER_NEXT" "$RUNNER_CANDIDATE_FILE.pin"
if ! RUNNER_VERSION_OUTPUT="$("$RUNNER_NEXT" --version)"; then
  printf 'Cannot validate %s; existing runner and server were preserved.\\n' "$REQUESTED_RUNNER" >&2; exit 1
fi
if [ -n "$EXPECTED_ARCHIVE_VERSION" ] && [ "$RUNNER_VERSION_OUTPUT" != "goat v$EXPECTED_ARCHIVE_VERSION" ]; then
  printf 'Expected goat v%s, observed %s; existing runner and server were preserved.\\n' "$EXPECTED_ARCHIVE_VERSION" "$RUNNER_VERSION_OUTPUT" >&2; exit 1
fi
if [ -n "$SELECTED_VERSION" ]; then
  # Cold mirrors installed this exact archive during validation; pin future use too.
  selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
  if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
    printf 'Validated selected archive is not complete.\\n' >&2; exit 1
  fi
  REQUIRE_INSTALLED=1
fi
RUNNER_CHANGED=0
@@T3_PROTOCOL_GUARD@@
check_candidate_protocol
check_live_protocol
if ! cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_NEXT"; then
  printf 'Candidate runner changed during validation; reconnect.\\n' >&2; exit 1
fi
# Last read-only checks immediately before publication; unknown never grants upgrade.
check_retained_runner
check_live_protocol
UPGRADE_PID="$LIVE_PID"; UPGRADE_PORT="$LIVE_PORT"; UPGRADE_VERSION="$LIVE_VERSION"
@@T3_RUNNER_INSTALL@@
`;

const REPLACE_RUNNER_INSTALL = `if [ -f "$RUNNER_FILE" ] && cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  rm -f "$RUNNER_NEXT"
else
  mv "$RUNNER_NEXT" "$RUNNER_FILE"
  RUNNER_CHANGED=1
fi`;
const KEEP_EXISTING_RUNNER_INSTALL = `if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  printf 'Selected retained runner changed before publication; reconnect.\\n' >&2; exit 1
fi
rm -f "$RUNNER_NEXT"`;
```

Candidate validation happens even for identical bytes, and before every install branch. Cold auth fallback can replace incompatible dormant runner bytes; it cannot restart a live server. Requested-version diagnostics still include the preparation wrapper's target/version prefix. Cleanup removes only its own temporary candidate; existing runtime directories stay item 2's protected inputs.

Insert `REMOTE_PROTOCOL_GUARD_SCRIPT` before the shared setup. It defines functions and runs them from the setup before publication and again before use. Shell positional token parsing occurs in functions, avoiding corruption of MCP's auth argument list. Missing-command exact fallback only applies to the binary, never a live server without independent descriptor evidence.

```ts
const REMOTE_PROTOCOL_GUARD_SCRIPT = `compatible_fields() {
  # version ssh orchestration; full matching integers OR exact legacy.
  [ "$2" = "@@T3_SSH_PROTOCOL@@" ] && [ "$3" = "@@T3_ORCHESTRATION_PROTOCOL@@" ] && return 0
  [ -n "$REQUESTED_VERSION" ] && [ "$1" = "$REQUESTED_VERSION" ] &&
    { [ "$2" = unknown ] || [ "$2" = "@@T3_SSH_PROTOCOL@@" ]; } &&
    { [ "$3" = unknown ] || [ "$3" = "@@T3_ORCHESTRATION_PROTOCOL@@" ]; }
}
check_candidate_protocol() {
  if [ -n "$SELECTED_VERSION" ] &&
     [ "$("$CHECK_RUNNER" --version 2>/dev/null || true)" != "goat v$SELECTED_VERSION" ]; then
    printf 'Selected executable changed before protocol use.\\n' >&2; exit 1
  fi
  if own="$("$CHECK_RUNNER" __ssh-helper protocol --shell 2>/dev/null)"; then
    set -f; set -- $own
    if ! valid_own_tokens "$@"; then printf 'Malformed candidate protocol output.\\n' >&2; exit 1; fi
    if [ -n "$SELECTED_VERSION" ] && [ "$1" != "$SELECTED_VERSION" ]; then
      printf 'Selected version and binary protocol identity disagree.\\n' >&2; exit 1
    fi
    if ! compatible_fields "$1" "$2" "$3"; then
      printf 'Candidate signals %s incompatible with SSH=%s orchestration=%s.\\n' "$own" "@@T3_SSH_PROTOCOL@@" "@@T3_ORCHESTRATION_PROTOCOL@@" >&2; exit 1
    fi
  elif [ -z "$SELECTED_VERSION" ] || [ "$SELECTED_VERSION" != "$REQUESTED_VERSION" ] ||
       [ "$("$CHECK_RUNNER" --version 2>/dev/null || true)" != "goat v$REQUESTED_VERSION" ]; then
    printf 'No protocol signals; only an independently proven exact release is allowed.\\n' >&2; exit 1
  fi
}
check_live_protocol() {
  LIVE_STATUS=none; LIVE_PID=0; LIVE_PORT=0; LIVE_VERSION=unknown
  LIVE_COMPATIBLE=0; LIVE_OWNED=0; NEEDS_OWNED_UPGRADE=0
  if live="$("$CHECK_RUNNER" __ssh-helper protocol --runtime-file "$DEFAULT_RUNTIME_FILE" --port-file "$PORT_FILE" --pid-file "$PID_FILE" --shell 2>/dev/null)"; then
    set -f; set -- $live
    if ! valid_live_tokens "$@"; then printf 'Malformed live protocol output.\\n' >&2; exit 1; fi
    LIVE_STATUS="$1"; LIVE_VERSION="$2"; LIVE_PID="$5"; LIVE_PORT="$6"
    stored_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    stored_kind="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
    stored_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
    # Only the helper's verified live identity can corroborate persisted ownership.
    if [ "$LIVE_STATUS" = live ] && valid_positive "$LIVE_PID" &&
       [ "$stored_kind" = managed ] && [ "$stored_pid" = "$LIVE_PID" ] &&
       [ "$stored_port" = "$LIVE_PORT" ]; then LIVE_OWNED=1; fi
    if [ "$LIVE_STATUS" = live ] && compatible_fields "$2" "$3" "$4" &&
       { [ -z "$SELECTED_VERSION" ] || [ "$2" = "$SELECTED_VERSION" ]; }; then LIVE_COMPATIBLE=1; fi
  else
    # An old helper may be absent, but identity files cannot be guessed away.
    if [ -e "$DEFAULT_RUNTIME_FILE" ] || [ -e "$PORT_FILE" ] || [ -e "$PID_FILE" ]; then LIVE_STATUS=unknown; fi
  fi
  if [ "$LIVE_STATUS" = unknown ]; then
    printf 'Cannot verify live GOAT PID=%s port=%s: descriptor unavailable or persisted identity disagrees. Repair the remote runtime metadata/descriptor and reconnect; runner and process were preserved.\\n' "$LIVE_PID" "$LIVE_PORT" >&2; exit 1
  fi
  if [ "$LIVE_STATUS" != none ] && [ "$LIVE_COMPATIBLE" != 1 ]; then
    if [ "$LIVE_STATUS" = live ] && [ "$LIVE_OWNED" = 1 ] && [ "$ALLOW_OWNED_UPGRADE" = 1 ] &&
       { [ -z "$SELECTED_VERSION" ] || [ "$SELECTED_VERSION" = "$REQUESTED_VERSION" ]; }; then
      NEEDS_OWNED_UPGRADE=1
    else
      printf 'Live GOAT PID=%s port=%s signals=%s incompatible or missing; expected SSH=%s orchestration=%s. It was left running. Upgrade with the owning client or reconnect.\\n' "$LIVE_PID" "$LIVE_PORT" "\${live:-unavailable}" "@@T3_SSH_PROTOCOL@@" "@@T3_ORCHESTRATION_PROTOCOL@@" >&2; exit 1
    fi
  else NEEDS_OWNED_UPGRADE=0; fi
}
recheck_selected_before_use() {
  check_retained_runner
  # Never let a vanished ready selection become a network install.
  if [ "$REQUIRE_INSTALLED" = 1 ] && [ -n "$SELECTED_VERSION" ]; then
    selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
    if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
      printf 'Selected GOAT runtime disappeared before use.\\n' >&2; exit 1
    fi
  fi
  if [ "$PRESERVE_SELECTED_RUNNER" = 1 ] &&
     [ "$(sed -n "s/^T3_ARCHIVE_VERSION='\\([^']*\\)'$/\\1/p" "$RUNNER_FILE")" != "$SELECTED_VERSION" ]; then
    printf 'Selected runner changed before use.\\n' >&2; exit 1
  fi
  # Subsequent reads use the published bytes, rechecking binary identity and live state.
  if ! cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_FILE"; then
    printf 'Published selected runner changed before use.\\n' >&2; exit 1
  fi
  CHECK_RUNNER="$RUNNER_FILE"
  check_candidate_protocol
  check_live_protocol
  CHECK_RUNNER="$RUNNER_CANDIDATE_FILE"
}
`;
```

The candidate path used by cleanup is immutable. A `.pin` copy of its validated bytes survives publication so every use detects runner changes, including same-version mirror/Node changes. The retained-source fingerprint additionally binds the pinned bytes to the probe; source and copy are hashed before execution/pinning and source is hashed again immediately before publication/use. Functions use `CHECK_RUNNER` and never alias the cleanup path to `run-t3.sh`; a failure during a post-publication guard therefore preserves the installed runner. Archive readiness is checked before invoking the wrapper, and exact legacy fallback repeats independent `--version` proof before use.

A fresh incompatibility after selecting an older compatible runtime cannot authorize restarting that older selection: owned upgrade is allowed only for the requested exact selection (or explicit dev script). The caller must reconnect/reprepare after such a race. Malformed successful own signals must fail rather than turn string/float/negative into missing. Both helpers' output tokens come from validated schemas and safe-integer checks; `compatible_fields` accepts only equality or literal `unknown`, never coercion.

## 6. Builder mappings and launch/auth lifecycle

Replace the shared setup builder completely with:

```ts
function buildRemoteRunnerSetupScript(
  input: RemoteT3RunnerOptions | undefined,
  selection: PreparedRemoteRuntime,
): string {
  const preserve = selection.source === "retained";
  return applyScriptPlaceholders(REMOTE_RUNNER_SETUP_SCRIPT, {
    T3_REQUESTED_RUNNER: shellSingleQuote(
      isNodeScriptRunner(input)
        ? `Node script ${input?.nodeScriptPath?.trim()}`
        : `GOAT ${selection.requestedVersion}`,
    ),
    T3_EXPECTED_ARCHIVE_VERSION: shellSingleQuote(selection.version ?? ""),
    T3_SELECTED_VERSION: shellSingleQuote(selection.version ?? ""),
    T3_REQUESTED_VERSION: shellSingleQuote(selection.requestedVersion ?? ""),
    T3_REQUIRE_INSTALLED: selection.requireInstalled ? "1" : "0",
    T3_PRESERVE_SELECTED_RUNNER: preserve ? "1" : "0",
    T3_ALLOW_OWNED_UPGRADE: selection.mayUpgradeOwnedServer ? "1" : "0",
    T3_RETAINED_RUNNER_SHA256: shellSingleQuote(selection.retainedRunnerSha256 ?? ""),
    T3_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
    T3_PROTOCOL_GUARD: applyScriptPlaceholders(REMOTE_PROTOCOL_GUARD_SCRIPT, {
      T3_SSH_PROTOCOL: String(SSH_RUNTIME_PROTOCOL_VERSION),
      T3_ORCHESTRATION_PROTOCOL: String(ORCHESTRATION_PROTOCOL_VERSION),
    }),
    T3_RUNNER_INSTALL: preserve ? KEEP_EXISTING_RUNNER_INSTALL : REPLACE_RUNNER_INSTALL,
  });
}
```

Add optional `selection` to the three existing public builders, preserving their existing argument order. One explicit mapping per builder:

```diff
-export function buildRemoteLaunchScript(input?: RemoteT3RunnerOptions): string {
+export function buildRemoteLaunchScript(input?: RemoteT3RunnerOptions,
+  selection = requestedRuntime(input)): string {
@@
-    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, input?.keepExistingRunner === true),
+    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, selection),
@@
-    T3_OWN_RUNTIME_CHECK: input?.keepExistingRunner
-      ? KEEP_OWN_RUNTIME_CHECK
-      : REPLACE_OWN_RUNTIME_CHECK,
-    T3_BUSY_SERVER_GUARD: input?.keepExistingRunner ? KEEP_BUSY_SERVER_GUARD : "",
@@
 export function buildRemoteMcpSessionScript(
@@
   input?: RemoteT3RunnerOptions,
+  selection = requestedRuntime(input),
@@
-    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, true),
+    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input,
+      { ...selection, mayUpgradeOwnedServer: false }),
@@
-export function buildRemotePairingScript(stateKey: string, input?: RemoteT3RunnerOptions): string {
+export function buildRemotePairingScript(stateKey: string, input?: RemoteT3RunnerOptions,
+  selection = requestedRuntime(input)): string {
@@
-    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, true),
+    T3_RUNNER_SETUP: buildRemoteRunnerSetupScript(input,
+      { ...selection, mayUpgradeOwnedServer: false }),
```

Remove launch's old post-publication executable warmup block. Shared candidate validation has already resolved archive installation or Node discovery; every subsequent binary invocation now has a fresh selected-runtime check:

```diff
 @@T3_RUNNER_SETUP@@
 T3_ARCHIVE_MODE=@@T3_ARCHIVE_MODE@@
-if [ "$T3_ARCHIVE_MODE" = "1" ]; then
-  # The archive ships the helpers below inside the executable; the remote
-  # needs no Node at all. Resolving the runner once here also downloads the
-  # archive before the port and readiness probes rely on it.
-  "$RUNNER_FILE" --version >/dev/null
-elif ! ensure_remote_node_path; then
-  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
-  exit 1
-fi
+recheck_selected_before_use
 pick_port() {
```

Launch already establishes `DEFAULT_SERVER_HOME` before the shared setup; pairing/MCP do too. The setup now establishes default-runtime/PID/port/managed paths for every entrypoint. Keep the initial Node environment fragment and selected mode in launch; staged `RUNNER_NEXT --version` performs Node discovery for explicit dev candidates through the existing wrapper. Preserve all helper function definitions after the removed warmup.

Replace `REMOTE_LAUNCH_SCRIPT`'s whole block from `REMOTE_PID="$(cat "$PID_FILE" ...` through the `fi` immediately before `if [ -z "$REMOTE_PORT" ]; then` with this block. Remove `resolve_default_runtime_port` completely: guard output has already validated the record and fetched the descriptor. Delete `REPLACE_OWN_RUNTIME_CHECK`, `KEEP_OWN_RUNTIME_CHECK` and the now-unused `KEEP_BUSY_SERVER_GUARD` completely. Its non-owner preservation behavior is included in the shared live guard and the readiness branch below. Keep pick-port/wait-ready/wait-for-PID-exit helpers and startup readiness/cleanup.

```sh
recheck_selected_before_use
REMOTE_PID=""
REMOTE_PORT=""
REMOTE_MANAGED=""
if [ "$LIVE_STATUS" != none ]; then
  if [ "$LIVE_COMPATIBLE" = 1 ]; then
    REMOTE_PORT="$LIVE_PORT"
    if ! wait_ready "@@T3_REUSE_READY_TIMEOUT_MS@@"; then
      printf 'Selected live server did not answer; it was left running.\n' >&2; exit 1
    fi
    recheck_selected_before_use
    if [ "$LIVE_COMPATIBLE" != 1 ]; then
      printf 'Live server compatibility changed during readiness; reconnect.\n' >&2; exit 1
    fi
    if [ "$LIVE_OWNED" = 1 ]; then
      REMOTE_PID="$LIVE_PID"
      REMOTE_MANAGED=managed
    else
      REMOTE_MANAGED=external
      rm -f "$PID_FILE"
      printf '%s\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\n' >"$MANAGED_FILE"
    fi
  elif [ "$NEEDS_OWNED_UPGRADE" = 1 ]; then
    # Recompute retained hash and verify the same live identity immediately before kill.
    recheck_selected_before_use
    if [ "$LIVE_STATUS" != live ] || [ "$LIVE_OWNED" != 1 ] ||
       [ "$NEEDS_OWNED_UPGRADE" != 1 ] || [ "$LIVE_PID" != "$UPGRADE_PID" ] ||
       [ "$LIVE_PORT" != "$UPGRADE_PORT" ] || [ "$LIVE_VERSION" != "$UPGRADE_VERSION" ]; then
      printf 'Owned GOAT identity changed before termination; process was left running.\n' >&2; exit 1
    fi
    PID_TO_STOP="$LIVE_PID"
    kill "$PID_TO_STOP" 2>/dev/null || true
    wait_for_pid_exit "$PID_TO_STOP"
    if kill -0 "$PID_TO_STOP" 2>/dev/null; then
      printf 'Owned server did not stop; ownership files were preserved.\n' >&2
      exit 1
    fi
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
  else
    printf 'Live GOAT compatibility changed; reconnect.\n' >&2; exit 1
  fi
fi
```

Before the existing `nohup ... serve` line, add another `recheck_selected_before_use`; if a new server appeared, fail rather than starting a competing process. Only the fresh `none` result permits spawn. The integrated reuse branch calls `wait_ready`, then rechecks identity/compatibility before adoption; failed readiness leaves the existing process untouched. When ready launch has returned, carry selection in the return; no new fields in its remote port JSON are needed.

```diff
   if [ -z "$REMOTE_PORT" ]; then
@@
-  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
+  recheck_selected_before_use
+  if [ "$LIVE_STATUS" != none ]; then
+    printf 'A server appeared before launch; reconnect without replacing it.\\n' >&2; exit 1
+  fi
+  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
```

In the plain shell after-block above use `\\n` rather than `\n` when inserting into its TypeScript template literal. Do not paste raw shell-dollar substitutions into unescaped TS `${...}`. There are no new placeholders left unresolved after building.

Pairing and MCP use the same pre-publication protocol guard, with restart authority false. Insert a fresh use check immediately before pairing auth. MCP must recheck before **both** attempts; restructure its condition so failed protocol checks cannot be mistaken for a ceiling option failure:

```diff
 PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
+recheck_selected_before_use
 "$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
@@
 CEILING=@@T3_CEILING@@
+recheck_selected_before_use
 if [ -n "$CEILING" ] && OUTPUT="$("$RUNNER_FILE" "$@" --runtime-mode-ceiling "$CEILING" 2>/dev/null)"; then
@@
 else
+  recheck_selected_before_use
   OUTPUT="$("$RUNNER_FILE" "$@")"
```

The integrated shared setup sets `REQUIRE_INSTALLED=1` after successful cold archive validation and verifies the selected marker. This closes the post-publication mirror fallback race; dev candidates have no archive marker. Downloader/archive-runner strings remain unchanged.

## 7. Carry preparation into every command and cached tunnel

These call-site hunks use the landed auth preparation signatures, not the earlier plan's pre-item-2 calls:

```diff
@@
-    { readonly remotePort: number; readonly remoteServerKind: "external" | "managed" | null },
+    { readonly remotePort: number; readonly remoteServerKind: "external" | "managed" | null;
+      readonly selectedRuntime: PreparedRemoteRuntime },
@@
-    yield* prepareRemoteRuntime(target, input ?? {}, runner, stateKey);
+    const selected = yield* prepareRemoteRuntime(target, input ?? {}, runner, stateKey);
@@
-      stdin: buildRemoteLaunchScript(runner),
-      timeoutMs: isNodeScriptRunner(runner)
+      stdin: buildRemoteLaunchScript(selected.runner, selected),
+      timeoutMs: isNodeScriptRunner(selected.runner)
@@
       remoteServerKind: parsed.serverKind ?? null,
+      selectedRuntime: selected,
```

Add `prepared?: PreparedRemoteRuntime` after `runner` in pairing and MCP. Replace each existing preparation block and builder call:

```diff
@@
-  yield* prepareRemoteRuntime(
+  const selected = prepared ?? (yield* prepareRemoteRuntime(
     target,
     input ?? {},
     { ...runner, keepExistingRunner: true },
     stateKey,
-  );
+  ));
@@
-    stdin: buildRemotePairingScript(stateKey, runner),
+    stdin: buildRemotePairingScript(stateKey, selected.runner,
+      { ...selected, mayUpgradeOwnedServer: false }),
@@
-    ...(isNodeScriptRunner(runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
+    ...(isNodeScriptRunner(selected.runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
@@
-    yield* prepareRemoteRuntime(
+    const selected = prepared ?? (yield* prepareRemoteRuntime(
       target,
       input ?? {},
       { ...runner, keepExistingRunner: true },
       stateKey,
-    );
+    ));
@@
-      stdin: buildRemoteMcpSessionScript(stateKey, sessionOptions, runner),
+      stdin: buildRemoteMcpSessionScript(stateKey, sessionOptions, selected.runner,
+        { ...selected, mayUpgradeOwnedServer: false }),
@@
-      ...(isNodeScriptRunner(runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
+      ...(isNodeScriptRunner(selected.runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
```

`selected.requestedVersion` persists even if the resolver is now a different version. Cached selection is a pin to revalidate, not an invitation to silently reprepare. Manager MCP reads it **inside the existing target lock**:

```diff
@@
 const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
+  readonly selectedRuntime: PreparedRemoteRuntime;
@@
   const tunnelEntry: SshTunnelEntry = {
+    selectedRuntime: input.selectedRuntime,
@@
           remoteServerKind: remoteLaunch.remoteServerKind,
+          selectedRuntime: remoteLaunch.selectedRuntime,
@@
-                issueRemotePairingToken(entry.target, authOptions, runner),
+                issueRemotePairingToken(entry.target, authOptions, runner, entry.selectedRuntime),
@@
-        operation: (authOptions) =>
-          issueRemoteMcpClientSession(resolvedTarget, sessionOptions, authOptions, runner),
+        operation: (authOptions) =>
+          issueRemoteMcpClientSession(resolvedTarget, sessionOptions, authOptions, runner,
+            tunnels.get(key)?.selectedRuntime),
```

Include selected/requested version in existing logs/spans alongside runner source, without tokens. `leaveRemoteServerRunning` and stale-forward/disconnect behavior from item 2 stay intact. Do not add or persist a new remote restart permission. A cached tunnel with failed readiness follows existing recovery; auth still performs a fresh remote guard even when supplied `prepared`.

## 8. Behavioral tests and fixture repairs

### Contracts/runtime/service tests

Append to existing contracts descriptor tests:

```ts
it("keeps legacy SSH signals absent and preserves explicit integers", () => {
  expect(decodeDescriptor(descriptor).sshRuntimeProtocolVersion).toBeUndefined();
  expect(
    decodeDescriptor({ ...descriptor, sshRuntimeProtocolVersion: 1 }).sshRuntimeProtocolVersion,
  ).toBe(1);
  for (const value of ["1", 1.5, null]) {
    expect(() => decodeDescriptor({ ...descriptor, sshRuntimeProtocolVersion: value })).toThrow();
  }
});
```

The SSH compatibility tests separately reject negative/future integers; `Schema.Int` itself is not the compatibility predicate.

```diff
--- a/apps/server/src/environment/ServerEnvironment.test.ts
+++ b/apps/server/src/environment/ServerEnvironment.test.ts
@@
 import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
+import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
@@
       expect(first.orchestrationProtocolVersion).toBe(ORCHESTRATION_PROTOCOL_VERSION);
+      expect(first.sshRuntimeProtocolVersion).toBe(SSH_RUNTIME_PROTOCOL_VERSION);
```

In runtime tests retain the old literal record round-trip (proves backward compatibility); add emitted metadata/format check and enriched persistence round-trip:

```ts
it.effect("records build protocols without changing format 1", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 13773,
    });
    assert.equal(state.version, 1);
    assert.equal(state.serverVersion, packageJson.version);
    assert.equal(state.sshRuntimeProtocolVersion, SSH_RUNTIME_PROTOCOL_VERSION);
    assert.equal(state.orchestrationProtocolVersion, ORCHESTRATION_PROTOCOL_VERSION);
    const path = `${root}/server-runtime.json`;
    yield* ServerRuntimeState.persistServerRuntimeState({ path, state });
    const read = yield* ServerRuntimeState.readPersistedServerRuntimeState(path);
    assert.deepEqual(Option.getOrThrow(read), state);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
```

Add imports from shared/contracts and `../package.json` to that existing test. Test invalid protocol fields through `readPersistedServerRuntimeState` with actual file contents; assert `Option.none` and decode log, preserving its existing error behavior.

### CLI tests: actual command and live servers

NEW `apps/server/src/cli/sshHelper.test.ts` uses Node `http` listeners bound to port 0, temp records and cleanup of listener handles. Call the exported observer against an actual loopback descriptor; do not stub its HTTP read. Exporting the observer enables narrow tests and the SSH fake executable to call production observation.

Use `Command.runWith(sshHelperCommand, {version: packageJson.version})(["protocol"])` with a captured stdout sink for command-registration/JSON shape, or a native Node subprocess importing `sshHelperCommand` and `Effect` then calling it; the latter must assert exit code, stderr and decoded exact three-field stdout. No app build is needed.

Required table rows: enriched record + matching descriptor → live; old format-1 record + exact legacy descriptor → live with absent integers; stale persisted version/protocol → unknown; string/fraction/negative protocol → unknown; PID dead but port answering → external PID=0; alive remembered PID with missing/malformed record → never owned; missing record + valid remembered loopback descriptor → external live; root 200/descriptor 404 → unknown; missing record and no remembered process/port → none; nonloopback or port/origin mismatch → unknown; serviceManaged → PID=0; oversized/trickling/malformed JSON descriptor → bounded unknown. Bind/close events and a controlled response stream establish milestones; no sleeps/polling in tests.

Complete NEW helper test skeleton; expand its cases with the table above rather than creating a fake observer:

```ts
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
import packageJson from "../../package.json" with { type: "json" };
import { readLiveSshRuntimeProtocol } from "./sshHelper.ts";

const startDescriptor = async (value: unknown) => {
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/t3/environment") response.end(JSON.stringify(value));
    else response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback port");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};
const descriptor = {
  environmentId: "helper-fixture",
  label: "Fixture",
  platform: { os: "linux", arch: "x64" },
  capabilities: {},
  serverVersion: packageJson.version,
  sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
};

describe("SSH runtime protocol", () => {
  it("registers the protocol command and prints only build JSON", async () => {
    const moduleUrl = new URL("./sshHelper.ts", import.meta.url).href;
    // Module specifier resolution originates in this real source directory, not HOME.
    const effectUrl = import.meta.resolve("effect/Effect");
    const cliUrl = import.meta.resolve("effect/cli");
    const script = `import * as Effect from ${JSON.stringify(effectUrl)};
import {Command} from ${JSON.stringify(cliUrl)};
import {sshHelperCommand} from ${JSON.stringify(moduleUrl)};
await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(['protocol']));`;
    const stdout = await new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        process.execPath,
        ["--input-type=module", "-e", script],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          if (stderr.trim()) {
            reject(new Error(stderr));
            return;
          }
          resolve(stdout);
        },
      );
    });
    expect(JSON.parse(stdout)).toEqual({
      serverVersion: packageJson.version,
      sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    });
  });

  for (const mode of ["matching", "legacy", "disagreeing", "malformed"] as const) {
    it(`checks a live loopback descriptor: ${mode}`, async () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-"));
      const liveDescriptor =
        mode === "legacy"
          ? {
              ...descriptor,
              sshRuntimeProtocolVersion: undefined,
              orchestrationProtocolVersion: undefined,
            }
          : mode === "malformed"
            ? { ...descriptor, sshRuntimeProtocolVersion: "1" }
            : descriptor;
      const server = await startDescriptor(liveDescriptor);
      try {
        const file = NodePath.join(home, "server-runtime.json");
        NodeFS.writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            pid: process.pid,
            port: server.port,
            origin: `http://127.0.0.1:${server.port}`,
            startedAt: new Date().toISOString(),
            ...(mode === "legacy"
              ? {}
              : {
                  serverVersion: packageJson.version,
                  sshRuntimeProtocolVersion:
                    mode === "disagreeing" ? 99 : SSH_RUNTIME_PROTOCOL_VERSION,
                  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                }),
          }),
        );
        const result = await readLiveSshRuntimeProtocol(file);
        expect(result.status).toBe(mode === "matching" || mode === "legacy" ? "live" : "unknown");
        if (result.status === "live") {
          expect(result.serverVersion).toBe(packageJson.version);
          expect(result.sshRuntimeProtocolVersion).toBe(
            mode === "legacy" ? undefined : SSH_RUNTIME_PROTOCOL_VERSION,
          );
        }
      } finally {
        await server.close();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
```

The test owns HTTP handles, not the test runner PID: `process.pid` is used only for signal-0 identity in a disposable record and is never killed. Real SSH process lifecycle tests below use captured fixture handles/PIDs. Add missing/malformed origin, remembered external-port, service-managed, oversized and response-deadline rows to the same helper file with the described observable outcomes.

### SSH isolated-HOME real-shell harness

Extend the existing `nativeScripts` function to accept optional `selection` and include the native probe. Native Node already preserves `Function.toString()` bytes that Vitest transforms. Do not regenerate a command from `ARCHIVE` inside the SSH interceptor: execute the actual submitted stdin, including selected version and passed authority.

```diff
 const nativeScripts = Effect.fn("test.nativeScripts")(function* (
   input: SshTunnel.RemoteT3RunnerOptions,
+  selection?: SshTunnel.PreparedRemoteRuntime,
@@
 const input = ${JSON.stringify(input)};
+const selection = ${JSON.stringify(selection)};
```

In its native process JSON, use `t.buildRemoteLaunchScript(input, selection)`, `t.buildRemotePairingScript("711bc738002d72fd", input, selection)`, `t.buildRemoteMcpSessionScript(..., input, selection)` and `probe: t.buildRemoteRuntimeProbeScript(input.archiveVersion ?? '', '711bc738002d72fd', true)`. Update returned type with `probe: string`. Assert no unresolved `@@T3_[A-Z_]+@@` in launch/pairing/MCP/probe; this supplements rather than replaces behavior.

Add the following executable fixture helper inside the existing POSIX-only real-shell suite. Its tiny binary models own metadata, but calls the **production** observer for live HTTP/identity validation. It imports the source helper through an absolute file URL; that source module resolves its dependencies in the repository, so no dependency symlink or live state is required. Native Node TS support is already used by `nativeScripts`.

```ts
const protocolExecutable = (
  version: string,
  signals: {
    ssh?: number;
    orchestration?: number;
    missingCommand?: boolean;
    ownTokens?: string;
    liveTokens?: string;
    descriptor404?: boolean;
  },
  state: string,
) => {
  const helperUrl = new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href;
  // From packages/ssh/src, ../../../apps resolves the repository apps directory.
  return `#!${process.execPath}
(async () => {
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { readLiveSshRuntimeProtocol } = await import(${JSON.stringify(helperUrl)});
const version = ${JSON.stringify(version)};
const fields = { serverVersion: version,
  ...${JSON.stringify(signals.ssh === undefined ? {} : { sshRuntimeProtocolVersion: signals.ssh })},
  ...${JSON.stringify(signals.orchestration === undefined ? {} : { orchestrationProtocolVersion: signals.orchestration })} };
const home = process.env.HOME;
const state = ${JSON.stringify(state)};
const test = path.join(home, ".test");
const runtimeFile = path.join(home, ".goat/userdata/server-runtime.json");
const args = process.argv.slice(2);
function event(type, extra = {}) { fs.appendFileSync(path.join(test, "events"), JSON.stringify({type, version, ...extra}) + "\\n"); }
if (args[0] === "--version") {
  event("version", { published: fs.existsSync(path.join(state, "run-t3.sh")) ? fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") : "" });
  console.log("goat v" + version);
} else if (args[0] === "__ssh-helper" && args[1] === "protocol") {
  if (${JSON.stringify(signals.missingCommand ?? false)}) process.exit(2);
  const at = args.indexOf("--runtime-file");
  const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
  const value = at < 0 ? fields : await readLiveSshRuntimeProtocol(args[at+1], flag("--port-file"), flag("--pid-file"));
  event("protocol", { live: at >= 0, status: value.status });
  if (args.includes("--shell")) {
    const injected = at < 0 ? ${JSON.stringify(signals.ownTokens ?? null)} : ${JSON.stringify(signals.liveTokens ?? null)};
    if (injected !== null) { console.log(injected); return; }
    console.log((value.status ? value.status + " " : "") + [value.serverVersion ?? "unknown",
      value.sshRuntimeProtocolVersion ?? "unknown", value.orchestrationProtocolVersion ?? "unknown",
      value.pid ?? 0, value.port ?? 0].join(" "));
  } else console.log(JSON.stringify(value));
} else if (args[0] === "__ssh-helper" && args[1] === "pick-port") {
  const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
    const port = socket.address().port; socket.close(() => console.log(port));
  });
} else if (args[0] === "__ssh-helper" && args[1] === "wait-ready") {
  // Fixture readiness uses an event, not polling or a delay.
  let record = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, "utf8")) : null;
  if (!record || !fs.existsSync(path.join(test, "accepted-ready-" + record.pid))) {
    const fd = fs.openSync(path.join(test, "ready.fifo"), "r");
    fs.readSync(fd, Buffer.alloc(32), 0, 32, null); fs.closeSync(fd);
    record = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    fs.writeFileSync(path.join(test, "accepted-ready-" + record.pid), "ready");
  }
  const req = http.get("http://127.0.0.1:" + args[2] + "/", res => {
    res.resume(); res.on("end", () => process.exit(res.statusCode === 200 ? 0 : 1));
  }); req.on("error", () => process.exit(1));
} else if (args[0] === "auth") {
  event("auth", { args });
  if (args.includes("--runtime-mode-ceiling") && fs.existsSync(path.join(test, "reject-ceiling"))) process.exit(2);
  console.log(JSON.stringify(args[1] === "pairing" ? {credential: version} : {token: version, expiresAt: null}));
} else if (args[0] === "serve") {
  const at = args.indexOf("--port"); const requested = at < 0 ? 0 : Number(args[at+1]);
  const descriptor = {environmentId: "fixture", label: "Fixture", platform: {os: "linux", arch: "x64"}, capabilities: {}, ...fields};
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/t3/environment" && ${JSON.stringify(signals.descriptor404 ?? false)}) {
      res.statusCode = 404; res.end("{}"); return;
    }
    res.end(req.url === "/.well-known/t3/environment" ? JSON.stringify(descriptor) : "ok");
  });
  process.on("SIGTERM", () => {
    event("stop");
    if (fs.existsSync(runtimeFile) && JSON.parse(fs.readFileSync(runtimeFile, "utf8")).pid === process.pid) fs.unlinkSync(runtimeFile);
    server.close(() => process.exit(0));
  });
  server.listen(requested, "127.0.0.1", () => {
    const record = {version: 1, pid: process.pid, port: server.address().port,
      origin: "http://127.0.0.1:" + server.address().port, startedAt: new Date().toISOString(), ...fields};
    fs.mkdirSync(path.dirname(runtimeFile), {recursive: true}); fs.writeFileSync(runtimeFile, JSON.stringify(record));
    fs.appendFileSync(path.join(test, "pids"), process.pid + "\\n");
    event("start", { runner: fs.readFileSync(path.join(state, "run-t3.sh"), "utf8") });
    if (args.includes("--test-seed")) {
      fs.writeFileSync(path.join(test, "accepted-ready-" + process.pid), "ready");
      console.log(JSON.stringify(record));
    }
    else { const fd = fs.openSync(path.join(test, "ready.fifo"), "w"); fs.writeSync(fd, "ready\\n"); fs.closeSync(fd); }
  });
} else process.exit(97);
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
};
```

The fixture embeds its actual disposable `state` path, never symlinks live state. Its FIFO handshake marks readiness by captured PID; seeded and newly launched servers use separate readiness records so the fixture cannot deadlock after a restart. Use the existing POSIX host skip and native Node requirement.

Complete runner fixture construction and action driver:

```ts
const makeProtocolFixture = Effect.fn("test.protocol.fixture")(function* (input: {
  live: boolean;
  kind: "managed" | "external";
  oldVersion: string;
  ssh?: number;
  orchestration?: number;
  missingCommand?: boolean;
  ownTokens?: string;
  liveTokens?: string;
  descriptor404?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-protocol-" });
  const key = yield* remoteStateKey(uploadTarget);
  const state = `${home}/.goat/ssh-launch/${key}`;
  const test = `${home}/.test`;
  const old = `${home}/.goat/runtime/goat/versions/${input.oldVersion}`;
  const cache = `${home}/cache`;
  for (const dir of [state, test, old, cache]) yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(`${test}/events`, "");
  yield* fs.writeFileString(`${test}/pids`, "");
  const fifo = yield* realSpawner.spawn(ChildProcess.make("mkfifo", [`${test}/ready.fifo`]));
  assert.equal(Number(yield* fifo.exitCode), 0);
  yield* fs.writeFileString(`${old}/goat`, protocolExecutable(input.oldVersion, input, state));
  yield* fs.chmod(`${old}/goat`, 0o700);
  yield* fs.writeFileString(`${old}/.install-complete`, input.oldVersion + "\n");
  const oldRunner = (yield* nativeScripts({ archiveVersion: input.oldVersion })).runner + "\n";
  yield* fs.writeFileString(`${state}/run-t3.sh`, oldRunner);
  yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
  yield* Effect.addFinalizer(() =>
    fs.readFileString(`${test}/pids`).pipe(
      Effect.flatMap((data) =>
        Effect.sync(() => {
          for (const pid of data.trim().split("\n").filter(Boolean).map(Number)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* captured fixture child already exited */
            }
          }
        }),
      ),
      Effect.ignore,
    ),
  );
  let pid = 0;
  let port = 0;
  if (input.live) {
    const child = yield* realSpawner.spawn(
      ChildProcess.make(`${old}/goat`, ["serve", "--test-seed"], {
        env: { HOME: home, PATH: process.env.PATH ?? "" },
        extendEnv: false,
      }),
    );
    const ready = JSON.parse(
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.mkString,
      ),
    ) as { pid: number; port: number };
    assert.equal(ready.pid, Number(child.pid));
    pid = ready.pid;
    port = ready.port;
    yield* fs.writeFileString(`${state}/pid`, `${pid}\n`);
    yield* fs.writeFileString(`${state}/port`, `${port}\n`);
    yield* fs.writeFileString(`${state}/managed`, input.kind + "\n");
  }
  const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
  const stage = `${home}/stage/${stem}`;
  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.writeFileString(
    `${stage}/goat`,
    protocolExecutable(ARCHIVE.archiveVersion, { ssh: 1, orchestration: 2 }, state),
  );
  yield* fs.chmod(`${stage}/goat`, 0o700);
  const packed = yield* realSpawner.spawn(
    ChildProcess.make("tar", ["-czf", `${cache}/${stem}.tar.gz`, "-C", `${home}/stage`, stem]),
  );
  assert.equal(Number(yield* packed.exitCode), 0);
  const crypto = yield* Crypto.Crypto;
  const sha = Hex.encode(
    yield* crypto.digest("SHA-256", yield* fs.readFile(`${cache}/${stem}.tar.gz`)),
  );
  yield* fs.writeFileString(`${cache}/${stem}.tar.gz.sha256`, `${sha}  ${stem}.tar.gz\n`);
  const runner = { ...ARCHIVE, archiveDirectory: cache };
  const remoteCommands: ChildProcess.Command[] = [];
  let uploads = 0;
  let gh = 0;
  let cacheReads = 0;
  const observedFs = FileSystem.FileSystem.of({
    ...fs,
    exists: (file) => {
      if (file.startsWith(cache)) cacheReads++;
      return fs.exists(file);
    },
    readFile: (file) => {
      if (file.startsWith(cache)) cacheReads++;
      return fs.readFile(file);
    },
  });
  let beforeCommand: ((script: string) => ReturnType<typeof fs.writeFileString>) | undefined;
  const setBeforeCommand = (callback: typeof beforeCommand) => {
    beforeCommand = callback;
  };
  const transport = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") return realSpawner.spawn(command);
    if (command.command === "gh") {
      gh++;
      return Effect.die("unexpected gh acquisition");
    }
    const at = command.args.indexOf("sh");
    if (at < 0) return realSpawner.spawn(command);
    remoteCommands.push(command);
    const args = command.args.slice(at + 1).filter((arg) => arg !== "-l");
    if (args.includes("-c")) uploads++;
    // Capture actual submitted bytes; inject races only at an observed command boundary.
    return Effect.gen(function* () {
      const stdin = command.options.stdin;
      if (stdin === undefined || typeof stdin !== "object" || !("stream" in stdin)) {
        return yield* realSpawner.spawn(
          ChildProcess.make("sh", ["-c", ["sh", ...args].join(" ")], {
            env: { HOME: home, PATH: process.env.PATH ?? "", LC_ALL: "C" },
            extendEnv: false,
            ...(stdin === undefined ? {} : { stdin }),
          }),
        );
      }
      const script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
      if (beforeCommand !== undefined) yield* beforeCommand(script);
      return yield* realSpawner.spawn(
        ChildProcess.make("sh", ["-c", ["sh", ...args].join(" ")], {
          env: { HOME: home, PATH: process.env.PATH ?? "", LC_ALL: "C" },
          extendEnv: false,
          stdin: { ...stdin, stream: Stream.make(new TextEncoder().encode(script)) },
        }),
      );
    });
  });
  const run = (entry: "launch" | "pairing" | "mcp", secondary = false) => {
    const inputRunner = { ...runner, keepExistingRunner: secondary };
    const action =
      entry === "launch"
        ? SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, inputRunner).pipe(
            Effect.map((result) => ({
              version: result.selectedRuntime.version,
              port: result.remotePort,
            })),
          )
        : entry === "pairing"
          ? SshTunnel.issueRemotePairingToken(uploadTarget, {}, inputRunner).pipe(
              Effect.map((result) => ({ version: result.credential, port: 0 })),
            )
          : SshTunnel.issueRemoteMcpClientSession(
              uploadTarget,
              { label: "fixture", ttl: "1h", runtimeModeCeiling: null },
              {},
              inputRunner,
            ).pipe(Effect.map((result) => ({ version: result.token, port: 0 })));
    return action.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, transport),
      Effect.provideService(FileSystem.FileSystem, observedFs),
      Effect.result,
    );
  };
  const snapshot = Effect.gen(function* () {
    const files = ["run-t3.sh", "pid", "port", "managed"];
    const values: Record<string, string | null> = {};
    for (const file of files)
      values[file] = (yield* fs.exists(`${state}/${file}`))
        ? yield* fs.readFileString(`${state}/${file}`)
        : null;
    const runtime = `${home}/.goat/userdata/server-runtime.json`;
    values.runtime = (yield* fs.exists(runtime)) ? yield* fs.readFileString(runtime) : null;
    values.oldExecutable = yield* fs.readFileString(`${old}/goat`);
    values.oldMarker = yield* fs.readFileString(`${old}/.install-complete`);
    return values;
  });
  return {
    home,
    state,
    test,
    old,
    pid,
    port,
    run,
    snapshot,
    fs,
    realSpawner,
    setBeforeCommand,
    counters: () => ({ uploads, gh, cacheReads }),
    remoteCommands,
  };
});
```

The fixture's `setBeforeCommand` hook captures actual SSH stdin, then replaces its consumed stream with the same bytes. Race tests select the shared setup script after probe completion, before launch/auth spawn; no timeout establishes ordering. Add a `FileSystem` readFileString counter for sidecar reads and bundle counters independently; zero observed acquisition includes all archive-related reads.

Required representative table test (POSIX only, `it.live`, real services/scoped cleanup):

```ts
for (const entry of ["launch", "pairing", "mcp"] as const) {
  for (const live of [false, true]) {
    it.live(`reuses older compatible ${entry}; live=${live}`, () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live,
          kind: "external",
          oldVersion: "1.2.2",
          ssh: 1,
          orchestration: 2,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, "1.2.2");
          if (live && entry === "launch") assert.equal(result.success.port, f.port);
        }
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const after = yield* f.snapshot;
        assert.equal(after.oldExecutable, before.oldExecutable);
        assert.equal(after.oldMarker, before.oldMarker);
        if (live) assert.equal(after.runtime, before.runtime);
        const events = (yield* f.fs.readFileString(`${f.test}/events`))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.isFalse(events.some((event) => event.type === "stop"));
        if (entry !== "launch")
          assert.equal(events.findLast((event) => event.type === "auth")?.version, "1.2.2");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
  it.live(`preserves incompatible shared server for ${entry}`, () =>
    Effect.gen(function* () {
      const f = yield* makeProtocolFixture({
        live: true,
        kind: "managed",
        oldVersion: "1.2.2",
        ssh: 99,
        orchestration: 2,
      });
      const before = yield* f.snapshot;
      const result = yield* f.run(entry, true);
      assert.isTrue(Result.isFailure(result));
      assert.deepEqual(yield* f.snapshot, before);
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${f.port}/.well-known/t3/environment`),
      );
      assert.equal(response.status, 200);
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      assert.notInclude(events, '"type":"stop"');
      assert.notInclude(events, '"type":"auth"');
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}
```

Add these executable regression rows to the same POSIX suite. They use actual generated setup/guard scripts and captured fixture processes:

```ts
for (const failure of ["stale metadata", "descriptor 404"] as const) {
  it.live(`owning launch preserves an unknown server: ${failure}`, () =>
    Effect.gen(function* () {
      const f = yield* makeProtocolFixture({
        live: true,
        kind: "managed",
        oldVersion: "1.2.2",
        ssh: 99,
        orchestration: 2,
        descriptor404: failure === "descriptor 404",
      });
      if (failure === "stale metadata") {
        const file = `${f.home}/.goat/userdata/server-runtime.json`;
        const record = JSON.parse(yield* f.fs.readFileString(file));
        yield* f.fs.writeFileString(file, JSON.stringify({ ...record, serverVersion: "1.2.1" }));
      }
      const before = yield* f.snapshot;
      const result = yield* f.run("launch", false);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.include(String(result.failure), "Cannot verify live GOAT");
      assert.deepEqual(yield* f.snapshot, before); // Includes runner publication/ownership/runtime bytes.
      yield* Effect.sync(() => process.kill(f.pid, 0)); // Captured fixture PID still alive.
      const root = yield* Effect.promise(() => fetch(`http://127.0.0.1:${f.port}/`));
      assert.equal(root.status, 200);
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      assert.notInclude(events, '"type":"stop"');
      assert.notInclude(events, '"type":"auth"');
      assert.equal(events.split('"type":"start"').length - 1, 1); // Only the seeded process.
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}

for (const entry of ["launch", "pairing", "mcp"] as const) {
  it.live(`refuses same-version retained runner replacement before ${entry}`, () =>
    Effect.gen(function* () {
      const f = yield* makeProtocolFixture({
        live: true,
        kind: "managed",
        oldVersion: "1.2.2",
        ssh: 1,
        orchestration: 2,
      });
      let replaced = false;
      f.setBeforeCommand((script) => {
        if (replaced || !script.includes('RUNNER_FILE="$STATE_DIR/run-t3.sh"')) return Effect.void;
        replaced = true;
        return Effect.gen(function* () {
          const file = `${f.state}/run-t3.sh`;
          const original = yield* f.fs.readFileString(file);
          // Keep exactly the same archive version; if executed, log a distinct side effect.
          const replacement = original.replace(
            "#!/bin/sh\n",
            `#!/bin/sh\nprintf 'replacement-executed\\n' >> '${f.test}/events'\n`,
          );
          assert.notEqual(replacement, original);
          yield* f.fs.writeFileString(file, replacement);
        });
      });
      const before = yield* f.snapshot;
      const result = yield* f.run(entry);
      assert.isTrue(replaced);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.include(String(result.failure), "changed since probe");
      const after = yield* f.snapshot;
      assert.notEqual(after["run-t3.sh"], before["run-t3.sh"]); // Only our injected replacement persists.
      assert.deepEqual({ ...after, "run-t3.sh": before["run-t3.sh"] }, before);
      assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      assert.notInclude(events, "replacement-executed");
      assert.notInclude(events, '"type":"stop"');
      assert.notInclude(events, '"type":"auth"');
      assert.equal(events.split('"type":"start"').length - 1, 1);
      yield* Effect.sync(() => process.kill(f.pid, 0));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  for (const tokens of [
    "unknown 1 2 0 0",
    "1.2.3 1 2 garbage garbage",
    "1.2.3 0 2 0 0",
    "1.2.3 1 -2 0 0",
    "1.2.3 01 2 0 0",
    "1.2.3-01 1 2 0 0",
    "1.2.3 1 2 0 1234",
  ] as const) {
    it.live(`rejects malformed own tokens before ${entry}: ${tokens}`, () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: 1,
          orchestration: 2,
          ownTokens: tokens,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.include(String(result.failure), "Malformed candidate protocol output");
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "serve", "start", "stop"])
          assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
  it.live(`accepts own not-running tokens and exact legacy fallback for ${entry}`, () =>
    Effect.gen(function* () {
      for (const missingCommand of [false, true]) {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: 1,
          orchestration: 2,
          missingCommand,
        });
        // A legacy helper cannot inspect remembered state; test cold absence with no runtime/identity files.
        const result = yield* f.run(entry);
        assert.isTrue(Result.isSuccess(result));
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
}
```

The exact legacy **launch** success row needs legacy pick-port/wait-ready support (already implemented by this fixture); absence refers only to the new `protocol` subcommand. Before launch spawn no identity files exist. After spawn readiness uses the established helpers; the new guard is not invoked after writing identity files. Missing protocol on an already remembered live server still rejects.

Execute the same malformed own/live tokens through the configured Node runner; these rows exercise all three builders without archive preparation:

```ts
for (const entry of ["launch", "pairing", "mcp"] as const) {
  for (const injected of [
    { ownTokens: "unknown 1 2 0 0" },
    { ownTokens: "1.2.3 1 2 garbage garbage" },
    { liveTokens: "live unknown 1 2 0 1234" },
    { liveTokens: "live 1.2.3 1 2 garbage garbage" },
  ]) {
    it.live(`rejects malformed Node ${entry} tokens: ${JSON.stringify(injected)}`, () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: 1,
          orchestration: 2,
        });
        const cli = `${f.home}/fixture-cli.cjs`;
        yield* f.fs.writeFileString(
          cli,
          protocolExecutable(
            "1.2.3",
            {
              ssh: 1,
              orchestration: 2,
              ...injected,
            },
            f.state,
          ),
        );
        const scripts = yield* nativeScripts({ nodeScriptPath: cli });
        const key = f.state.slice(f.state.lastIndexOf("/") + 1);
        // nativeScripts' default key is an existing fixture constant; preserve all other script bytes.
        const script = scripts[entry].split("711bc738002d72fd").join(key);
        const before = yield* f.snapshot;
        const child = yield* f.realSpawner.spawn(
          ChildProcess.make("sh", ["-s", "--", key], {
            env: { HOME: f.home, PATH: process.env.PATH ?? "", LC_ALL: "C" },
            extendEnv: false,
            stdin: { stream: Stream.make(new TextEncoder().encode(script)), endOnDone: true },
          }),
        );
        const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString);
        assert.notEqual(Number(yield* child.exitCode), 0);
        assert.include(stderr, "Malformed");
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "start", "stop"]) assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
  for (const liveTokens of ["live unknown 1 2 0 1234", "live 1.2.3 1 2 garbage garbage"]) {
    it.live(`rejects malformed archive live tokens before ${entry}: ${liveTokens}`, () =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: ARCHIVE.archiveVersion,
          ssh: 1,
          orchestration: 2,
          liveTokens,
        });
        const before = yield* f.snapshot;
        const result = yield* f.run(entry);
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(yield* f.snapshot, before);
        assert.deepEqual(f.counters(), { uploads: 0, gh: 0, cacheReads: 0 });
        const events = yield* f.fs.readFileString(`${f.test}/events`);
        for (const type of ["auth", "start", "stop"]) assert.notInclude(events, `"type":"${type}"`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
}
```

The successful compatible fixture rows exercise the helper producer's own `<exact> 1 2 0 0` and canonical `none unknown unknown unknown 0 0`; unknown preservation rows cover the state that carries no version. The Node case deliberately has no exact archive identity and cannot use legacy fallback. Never replace these end-to-end rows with assertions on validator source text.

Place the table inside existing `describe.skipIf(windowsHost)` so unsupported Windows shell tests are explicitly skipped; never claim Windows ran them. Native commands are test-only fake binaries, not production remote Node dependencies.

Expand this same harness for every acceptance row above, especially:

- Missing command, missing one integer, explicit mismatch, malformed successful tokens and wrong version. Cold fallback asserts one requested upload, preserved old executable/marker, and auth/start at requested version. Same exact mismatch asserts failure, not legacy success.
- Owned incompatible upgrade asserts event order **candidate version/protocol validation → publication → stop → start** and the new PID; original default runtime PID equals recorded owned PID. Inject candidate validation failure and assert full snapshot unchanged plus original process still answers. Owning stale-metadata and descriptor-404 regressions above explicitly exercise the unknown branch. Check sibling `.t3` sentinel bytes unchanged.
- Cross-release disappearance/marker removal and retained runner replacement are injected **after prepare's probe**, using the captured next command boundary. Assert no wrapper download/gh/upload after the selection and no publication/auth/serve. Pin cleanup failure leaves installed runner intact and removes only this invocation's `.next`/`.pin`.
- Record missing/malformed, stale metadata, root-only server and mismatched owned PID: assert no stop, no changes to runner/ownership/runtime bytes. Helper observer must hit a real loopback descriptor rather than production-state mocks.
- Compatible owned PID preserves all ownership bytes and performs no stop/start. Compatible external adoption may write target port/managed markers, but never stops the server.
- Explicit Node script advertises matching fields and serves/authenticates through the configured path, never archive/cache acquisition; missing dev metadata rejects. Run in isolated HOME with ambient `T3CODE_HOME` sentinel.
- Manager resolve returns requested release A, selection chooses older B, resolver later returns C: pairing and MCP execute B and revalidate; a stale B errors rather than uploading C. Use existing manager transport doubles only for local forward/lifecycle, plus actual generated remote guard. Ensure MCP ceiling rejection's second attempt rechecks selected B.

Existing tests require intentional repairs, not removal: mirror-only manager/launch doubles now receive a read-only probe instead of skipping preparation. Return `{platform,arch,ready:true}` for exact requested cases, or complete retained/live evidence for cross-release cases; do not blindly return `retained:'ready'`. Existing retained-missing rows previously asserted item 2's error; now dormant incompatible/missing selection falls back to requested exact acquisition, while live shared incompatibility remains an error. Existing shell doubles that print version for every argument must return unsupported-helper exit for legacy-command tests, or implement own/live signals for protocol tests. Native switch fixtures need format-1 `startedAt`, descriptor endpoint and protocol command to establish live identity.

`packages/ssh/src/tunnel.mcpSession.test.ts` currently writes arbitrary fake auth bytes directly into `run-t3.sh`; this no longer proves a selected runtime. Install the fake into `~/.goat/runtime/goat/versions/<exact>/goat` with matching marker, generate the runner via native Node, and provide a retained selection. Handle `--version`, own `protocol --shell`, and live `protocol ... --shell` before auth logging; own output is `<exact> 1 2 0 0`, cold live output `none unknown unknown unknown 0 0`. Only auth invocations populate `call-1.args`/`call-2.args`. Keep argument quoting, base-dir and ceiling fallback assertions; add preservation failure tests for a changed selected runner. Do not bypass production staging to preserve old mocks.

## 9. Frozen fixture impact and controlled amendment

Relative to **b79ff462c's item-2 fixture (unchanged since 480ed90da)**, change exactly:

- `archive.launch`, `mirror.launch`, `node.launch`: shared staged protocol guard, corrected adoption and use rechecks.
- `archive.pairing`, `mirror.pairing`, `node.pairing`: the same setup and auth recheck.
- `archive.runner`, `mirror.runner`, `node.runner`: unchanged. Downloader, archive locks, placeholder primitive, uploaded-installer extraction and Node discovery remain item 1/2 behavior.

Fixture schema has no MCP/probe fields. Keep that schema; behavioral tests cover them. Review fixture before/after by decoded keys and semantic shell content. A fixture update alone is not evidence of compatible live reuse.

Future controlled fixture command (**NOT RUN**, writes only the six approved fixture fields after source implementation):

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
node --input-type=module <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as t from './packages/ssh/src/tunnel.ts';
const file = './packages/ssh/src/fixtures/remote-runner-baseline.json';
const before = JSON.parse(fs.readFileSync(file, 'utf8'));
const after = structuredClone(before);
const inputs = {
  archive: {archiveVersion:'1.2.3-preview.20260911.4'},
  mirror: {archiveVersion:'1.2.3-preview.20260911.4',releaseBaseUrl:'https://example.invalid/mirror/'},
  node: {nodeScriptPath:'/fixture/cli entry.mjs',nodeEngineRange:'^22.16 || ^23.11 || >=24.10'},
};
for (const key of ['archive','mirror','node']) {
  assert.equal(t.buildRemoteT3RunnerScript(inputs[key]), before[key].runner);
  assert.deepEqual(Object.keys(after[key]), Object.keys(before[key]));
  after[key].launch=t.buildRemoteLaunchScript(inputs[key]);
  after[key].pairing=t.buildRemotePairingScript('711bc738002d72fd',inputs[key]);
  assert.equal(after[key].runner,before[key].runner);
}
assert.deepEqual(Object.keys(after),Object.keys(before));
fs.writeFileSync(file,JSON.stringify(after,null,2)+'\n');
NODE
```

## 10. Exact future verification commands — NOT RUN

All listed paths/configs and existing test targets were re-verified at b79ff462c; they are unchanged since the 480ed90da inspection. The new helper test remains a future file. Do not build, launch an app/browser, run full suites or run repository-wide checks. Each test command directly names its changed test files; each package tsconfig includes `src`. Server uses its own config. Compiler checks observe source through those includes, not this prose. Parent's architect/audit review validates the plan.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh
../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/tunnel.test.ts src/tunnel.mcpSession.test.ts src/runtimeArchive.test.ts
```

Expected: existing item 1/2 acquisition, install preservation, disconnect/stale-forward and MCP tests plus all compatibility/race cases pass. POSIX real-shell rows explicitly skip only on Windows. `runtimeArchive.test.ts` observes the retained checksum/acquisition assumptions; no new packaging tests belong to this unit.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/contracts
../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/environment.test.ts
```

Expected: old descriptor omits SSH field, explicit integer round-trips, malformed types reject.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server
../../node_modules/.bin/vp test run --config vite.config.ts src/cli/sshHelper.test.ts src/serverRuntimeState.test.ts src/environment/ServerEnvironment.test.ts
```

Expected: actual helper command prints three-field JSON; loopback observer's table passes; old format-1 and enriched records round-trip; service descriptor emits current constant.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
./node_modules/.bin/vp exec tsc -p packages/shared/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p packages/contracts/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p packages/ssh/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p apps/server/tsconfig.json --noEmit
```

Expected: four targeted compiler exits 0, including the new shared export and all preparation return branches/cached consumers. No claim of compiler success in this rewrite. Targeted lint for the listed source/test files uses the repo's existing lint tool after parent confirms its precise file-argument syntax; no invented repository-wide lint command is offered as proof.

Read-only source gates (future, also NOT RUN):

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
rg -n 'SSH_RUNTIME_PROTOCOL_VERSION = ' packages/shared/src
rg -n 'sshRuntimeProtocolVersion|serverVersion|orchestrationProtocolVersion' packages/contracts/src/environment.ts apps/server/src/environment/ServerEnvironment.ts apps/server/src/serverRuntimeState.ts apps/server/src/cli/sshHelper.ts
rg -n 'selectedRuntime|prepareRemoteRuntime\(|recheck_selected_before_use|check_live_protocol|mayUpgradeOwnedServer' packages/ssh/src/tunnel.ts
rg -n 'version: Schema.Literal\(1\)|version: 1' apps/server/src/serverRuntimeState.ts
rg -n 'KEEP_OWN_RUNTIME_CHECK|REPLACE_OWN_RUNTIME_CHECK|T3_OWN_RUNTIME_CHECK|verify_runner_next' packages/ssh/src/tunnel.ts
rg -n '(sshRuntimeProtocolVersion|orchestrationProtocolVersion).*\?\?' packages/ssh/src/tunnel.ts apps/server/src/cli/sshHelper.ts
```

Expected: one constant definition; complete emission/decode/consumer chain; all three entrypoints use preparation result and fresh use guard; format literal 1; obsolete textual ownership/conditional-validation fragments absent. Last two searches should return **exit 1/no matches**; report that as their expected negative gate, not failed testing. Helper shell serialization uses explicit unknown tokens via field-presence tests, so no protocol default-coercion hits. Production fixture doubles may print `unknown` for absence, but cannot be used as current protocol evidence.

## Parent integration notes

The source hunks in sections 5–6 are a single integrated patch: shared setup already contains immutable cleanup, pinned runner bytes, cold-install readiness and check-runner data flow. Apply it before any test or fixture update. They resolve audit finding 6 at the landed shared staging boundary across launch/pairing/MCP. Do not resurrect the prior launch-only `chmod "$RUNNER_FILE"` pseudo-anchor or the old pairing call without stateKey.

No desktop identity/file/workflow dependency remains. Remote home stays `~/.goat`; packaged desktop profile decisions belong to item 4. Required observable authority policy is part of the parent A4 disposition, not a new restart authorization. Future unit completion must record source SHA, focused verifier results, reviewed fixture keys and independent review; this leaf supplies only this rewrite.

## Amendment verification — read-only / in memory

Verified against `git show b79ff462c:<path>`: all **51/51** contiguous before-images match and all 51 ordered diff hunks apply in memory. Complete production after-block replacements, insertions, launch adoption/deletion ranges and prepared-parameter additions also apply to that memory copy. Native Node TypeScript stripping plus ESM syntax checks passed for contracts, service descriptor, runtime state, CLI helper and SSH tunnel. This is syntax/application evidence, not typecheck or implementation-test evidence; no source checkout was written.

Decoded the actual plan's TS token/guard templates into shell in memory: `sh -n` passed; **16/16** own/live/none/unknown token cases passed, including accepted own `1.2.3 1 2 0 0`, rejected `unknown 1 2 0 0`, rejected `1.2.3 1 2 garbage garbage`, canonical prerelease/build and legacy unknown integers. Executing the amended `check_live_protocol` with owning PID/port markers and `unknown unknown unknown unknown 12345 3773` produced **`upgrade=0 published=0 killed=0`, exit 1** and the actionable descriptor/identity error. The live incompatible control produced `upgrade=1`, exit 0. The plan's retained hash guard rejected a mismatched SHA for launch/pairing/MCP with `published=0 killed=0`; the real installed SHA tool matched Python's SHA-256 of an existing read-only file. Shell stubs modeled observations only, with no process stop or publication.

Focused production suites and the newly specified real-HOME regression tests remain **NOT RUN**; the parent executes them after source implementation. No scope expansion, source write, branch operation, child dispatch or FSM/goal action occurred.

## Audit cycle 4 integration note

Cycle-4 requirements are executable in sections 2–6 and 8: verified-live ownership gates publication/termination, retained SHA-256 flows from probe through selection/builders to pin/use checks, and the producer/probe/guards share the token grammar (including valid own `0 0`). Verification evidence above covers baseline applicability and the unknown guard; production focused suites remain future work.
