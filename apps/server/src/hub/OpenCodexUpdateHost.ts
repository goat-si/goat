import { GoatHostStatusResult } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { OPEN_CODEX_PINNED_VERSION, resolveOpenCodexRelease } from "@goat/shared/opencodexRelease";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import { countHostThreads, interruptibleTurns, runningSubagents } from "../mcp/hostStatusModel.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { GOAT_INSTALLS_OPENCODEX, quoteGoatExecutable } from "../opencodex/childPrepare.ts";
import * as Installation from "../opencodex/OpenCodexInstallation.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HubParity from "./HubParity.ts";
import { isStableOpenCodexVersion, type OpenCodexUpdateMember } from "./opencodexUpdatePlan.ts";

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const EXIT = /\n?__goat_ocx_exit=(\d+)\s*$/u;
const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);

export interface OpenCodexRelease {
  readonly version: string;
  readonly publishedAt: string | undefined;
}

/**
 * The only seam to devices and the installer; tests replace it with a scripted fake. `member`
 * always reads fresh evidence, because a health check must not see a cached pre-update answer.
 */
export class OpenCodexUpdateHost extends Context.Service<
  OpenCodexUpdateHost,
  {
    readonly latestRelease: Effect.Effect<OpenCodexRelease | undefined>;
    readonly member: (
      alias: string | null,
      scope: McpInvocationScope,
    ) => Effect.Effect<OpenCodexUpdateMember>;
    /** Installs only a GOAT-pinned managed release and restarts its service. */
    readonly install: (alias: string | null, version: string) => Effect.Effect<boolean>;
    /**
     * Stops new turns on the member before it restarts, as ADR-0019 activation does. False when
     * that host offers no way to hold admission; GOAT can only hold its own.
     */
    readonly holdAdmission: (alias: string | null) => Effect.Effect<boolean>;
    readonly releaseAdmission: (alias: string | null) => Effect.Effect<void>;
  }
>()("goat/hub/OpenCodexUpdateHost") {}

/** Script-safe by construction: the version passed `isStableOpenCodexVersion`. */
const installScript = (version: string, goatExecutable: string) => {
  if (!isStableOpenCodexVersion(version)) throw new TypeError("Unsafe OpenCodex version.");
  return [
    `goat_cli=${quoteGoatExecutable(goatExecutable)}`,
    "[ -x \"$goat_cli\" ] || { printf '\\n__goat_ocx_exit=1\\n'; exit 0; }",
    `${GOAT_INSTALLS_OPENCODEX} || { printf '\\n__goat_ocx_exit=1\\n'; exit 0; }`,
    `goat_ocx=$("$goat_cli" opencodex install --managed-version '${version}' --print-path </dev/null) || { printf '\\n__goat_ocx_exit=1\\n'; exit 0; }`,
    '"$goat_ocx" restart </dev/null >/dev/null 2>&1',
    "printf '\\n__goat_ocx_exit=%s\\n' \"$?\"",
    "",
  ].join("\n");
};
const succeeded = (stdout: string) => EXIT.exec(stdout)?.[1] === "0";

const makeHost = Effect.gen(function* () {
  const parity = yield* HubParity.HubParity;
  const hosts = yield* HostThreads.HostThreadsMcpService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const runner = yield* ProcessRunner.ProcessRunner;
  const admission = yield* RuntimeAdmission.RuntimeAdmission;
  const installation = yield* Installation.OpenCodexInstallation;
  const catalog = yield* Installation.ReleaseCatalog;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const cwd = yield* HostProcess.WorkingDirectory;

  // GOAT installs only what it pins, so the newest release it offers is its compiled pin.
  const pinned = resolveOpenCodexRelease(platform, arch, OPEN_CODEX_PINNED_VERSION, catalog);
  const latestRelease = Effect.succeed(
    pinned === undefined ? undefined : { version: pinned.version, publishedAt: pinned.publishedAt },
  );

  const member = Effect.fn("OpenCodexUpdateHost.member")(function* (
    alias: string | null,
    scope: McpInvocationScope,
  ) {
    if (alias === null) {
      // Admitted requests first: one that commits after the thread read is then still counted.
      // A delegated child keeps running after its parent's turn ends; restarting OpenCodex
      // under either interrupts work.
      const inFlight = yield* admission.inFlight;
      const snapshot = yield* parity.readLocal;
      const shells = yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: true })
        .pipe(Effect.option);
      return {
        alias,
        snapshot,
        runningTurns: Option.isSome(shells)
          ? countHostThreads(shells.value).running + runningSubagents(shells.value) + inFlight
          : undefined,
      };
    }
    const status = yield* hosts
      .readOnHost(
        scope,
        {
          host: alias,
          tool: "goat_host_status",
          arguments: { local: true, parityEvidence: true },
          timeoutMs: 10_000,
        },
        decodeStatus,
      )
      .pipe(Effect.option);
    const entry = Option.isSome(status)
      ? status.value.hosts.find(({ host }) => host === null)
      : undefined;
    const live = entry?.reachability === "ok" && !entry.lastKnown ? entry.metrics : undefined;
    return {
      alias,
      snapshot: live?.opencodex,
      runningTurns: live === undefined ? undefined : interruptibleTurns(live.threads),
    };
  });

  const install = Effect.fn("OpenCodexUpdateHost.install")(function* (
    alias: string | null,
    version: string,
  ) {
    if (alias === null) {
      const installed = yield* installation
        .install({ managedVersion: version })
        .pipe(Effect.option);
      if (Option.isNone(installed)) return false;
      const output = yield* runner
        .run({
          command: installed.value.path,
          args: ["restart"],
          env: environment,
          cwd,
          timeout: INSTALL_TIMEOUT_MS,
          maxOutputBytes: 64 * 1024,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      return Option.isSome(output) && output.value.code === 0 && !output.value.timedOut;
    }
    // Only the alias's own provisioned GOAT installs there; nothing looks up a public command.
    const goatExecutable = yield* dispatch
      .provisionedRuntimeExecutable(alias)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (goatExecutable === undefined || !isStableOpenCodexVersion(version)) return false;
    const output = yield* dispatch
      .runHostScript({
        host: alias,
        script: installScript(version, goatExecutable),
        timeoutMs: INSTALL_TIMEOUT_MS,
      })
      .pipe(Effect.option);
    return Option.isSome(output) && succeeded(output.value.stdout);
  });

  return OpenCodexUpdateHost.of({
    latestRelease,
    member,
    install,
    holdAdmission: (alias) =>
      alias === null ? admission.beginDrain.pipe(Effect.as(true)) : Effect.succeed(false),
    releaseAdmission: (alias) => (alias === null ? admission.resume : Effect.void),
  });
});

export const layerHost = Layer.effect(OpenCodexUpdateHost, makeHost);
