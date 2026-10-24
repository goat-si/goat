import { GoatHostStatusResult } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import { countHostThreads, interruptibleTurns, runningSubagents } from "../mcp/hostStatusModel.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HubParity from "./HubParity.ts";
import { isStableOpenCodexVersion, type OpenCodexUpdateMember } from "./opencodexUpdatePlan.ts";

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const PACKAGE = "@bitkyc08/opencodex";
const REGISTRY_URL = "https://registry.npmjs.org/@bitkyc08%2fopencodex";
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const EXIT = /\n?__goat_ocx_exit=(\d+)\s*$/u;
const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);
const Packument = Schema.Struct({
  "dist-tags": Schema.Struct({ latest: Schema.optional(Schema.String) }),
  time: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodePackument = Schema.decodeUnknownOption(Schema.fromJsonString(Packument));

export interface OpenCodexRelease {
  readonly version: string;
  readonly publishedAt: string | undefined;
}

/**
 * The only seam to devices and the registry; tests replace it with a scripted fake. `member`
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
    /** Installs exactly `version` with OpenCodex's npm installer and restarts the service. */
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
const installScript = (version: string) => {
  if (!isStableOpenCodexVersion(version)) throw new TypeError("Unsafe OpenCodex version.");
  return [
    'PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"',
    `if ! npm install -g '${PACKAGE}@${version}' </dev/null >/dev/null 2>&1; then printf '\\n__goat_ocx_exit=1\\n'; exit 0; fi`,
    "goat_prefix=$(npm prefix -g 2>/dev/null) || goat_prefix=",
    "if [ -z \"$goat_prefix\" ]; then printf '\\n__goat_ocx_exit=1\\n'; exit 0; fi",
    '"$goat_prefix/bin/ocx" restart </dev/null >/dev/null 2>&1',
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
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const environment = yield* HostProcess.Environment;
  const cwd = yield* HostProcess.WorkingDirectory;

  const latestRelease = Effect.scoped(
    Effect.gen(function* () {
      const response = yield* http.execute(HttpClientRequest.get(REGISTRY_URL));
      if (response.status !== 200) return undefined;
      let size = 0;
      const text = yield* response.stream.pipe(
        Stream.tap((chunk) => {
          size += chunk.byteLength;
          return size > MAX_REGISTRY_BYTES ? Effect.fail("too-large" as const) : Effect.void;
        }),
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (body, chunk) => body + chunk,
        ),
      );
      const packument = Option.getOrUndefined(decodePackument(text));
      const version = packument?.["dist-tags"].latest;
      return version === undefined
        ? undefined
        : { version, publishedAt: packument?.time?.[version] };
    }),
  ).pipe(
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => undefined),
    Effect.withSpan("OpenCodexUpdateHost.latestRelease"),
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
    const script = installScript(version);
    if (alias === null) {
      const output = yield* runner
        .run({
          command: "/bin/sh",
          args: ["-c", script],
          env: environment,
          cwd,
          timeout: INSTALL_TIMEOUT_MS,
          maxOutputBytes: 64 * 1024,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      return Option.isSome(output) && !output.value.timedOut && succeeded(output.value.stdout);
    }
    const output = yield* dispatch
      .runHostScript({ host: alias, script, timeoutMs: INSTALL_TIMEOUT_MS })
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
