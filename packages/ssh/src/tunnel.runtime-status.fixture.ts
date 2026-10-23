import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION, type SshHostResult } from "@goat/contracts";
import * as NetService from "@goat/shared/Net";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  makeSuccessfulProcess,
  makeRunningProcess,
  testNetService,
  isRemoteLaunch,
} from "./tunnel.fixture.ts";

/** A scripted SSH host for runtime status: probe answers, launches, forwards and readiness. */
export const signals = (version: string) => ({
  serverVersion: version,
  sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
});
export const stopped = { platform: "linux", arch: "x64", ready: false, liveStatus: "none" };
export const retained = {
  ...stopped,
  retained: "ready",
  retainedVersion: "1.2.2",
  retainedSignals: signals("1.2.2"),
  retainedRunnerSha256: "a".repeat(64),
};
export const successfulStatus = (result: SshHostResult) => {
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") throw new Error("Expected an SSH status");
  return result.status;
};

export const fixture = (
  initial: unknown,
  runnerOptions: SshTunnel.RemoteGoatRunnerOptions = {},
  afterUpload: Effect.Effect<void> = Effect.void,
) => {
  let probe = initial;
  let probeFailure: string | undefined;
  let toolFixProbe = "1000\nLinux\nID=debian\n";
  let launchVersion = ARCHIVE.archiveVersion as string;
  let drainPending = false;
  let drainReplacement: "older" | "capability" = "older";
  let launchDefect = false;
  // The version the server behind a forward reports; unset answers no descriptor.
  let descriptorVersion: string | undefined;
  let readinessGate:
    | { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined;
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/goat/environment" && descriptorVersion !== undefined)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ serverVersion: descriptorVersion }), { status: 200 }),
        );
      const gate = readinessGate;
      if (gate !== undefined && path === "/") {
        readinessGate = undefined;
        yield* Deferred.succeed(gate.entered, undefined);
        yield* Deferred.await(gate.release);
      }
      return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
    }),
  );
  const calls = { probes: 0, uploads: 0, launches: 0, forwards: 0, prompts: 0, strict: false };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
      if (command.args.includes("-G"))
        return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
      if (command.args.includes("-N")) {
        calls.forwards++;
        return makeRunningProcess(() => undefined);
      }
      const input = command.options.stdin;
      if (command.args.includes("-c")) {
        calls.uploads++;
        if (
          input !== undefined &&
          typeof input === "object" &&
          "stream" in input &&
          Stream.isStream(input.stream)
        )
          yield* Stream.runDrain(input.stream);
        yield* afterUpload;
        return makeSuccessfulProcess("goat uploaded");
      }
      const script =
        input !== undefined &&
        typeof input === "object" &&
        "stream" in input &&
        Stream.isStream(input.stream)
          ? yield* input.stream.pipe(Stream.decodeText(), Stream.mkString)
          : "";
      if (script.includes("GOAT_TOOL_FIX_PROBE")) return makeSuccessfulProcess(toolFixProbe);
      if (command.args.includes("goat-runtime-cleanup")) return makeSuccessfulProcess("");
      if (script.includes("ready=false") && !isRemoteLaunch(command.args)) {
        calls.probes++;
        calls.strict = ["StrictHostKeyChecking=yes", "UpdateHostKeys=no", "BatchMode=yes"].every(
          (arg) => command.args.includes(arg),
        );
        if (probeFailure !== undefined)
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
            stderr: Stream.make(new TextEncoder().encode(probeFailure)),
          };
        return makeSuccessfulProcess(typeof probe === "string" ? probe : JSON.stringify(probe));
      }
      calls.launches++;
      if (launchDefect) return yield* Effect.die(new Error("launch defect"));
      return makeSuccessfulProcess(
        JSON.stringify({
          status: "ready",
          selectedVersion: launchVersion,
          remotePort: 3773,
          serverKind: "managed",
          ...(drainPending
            ? {
                pending: {
                  reason: "unknown",
                  refreshCause: "drain_unavailable",
                  replacement: drainReplacement,
                  requestedVersion: ARCHIVE.archiveVersion,
                  liveVersion: launchVersion,
                },
              }
            : {}),
        }),
      );
    }),
  );
  return {
    calls,
    setToolFixProbe: (value: string) => {
      toolFixProbe = value;
    },
    setProbe: (value: unknown) => {
      probe = value;
    },
    failProbe: (value: string) => {
      probeFailure = value;
    },
    setDrainPending: (replacement: "older" | "capability" = "older") => {
      drainPending = true;
      drainReplacement = replacement;
    },
    setLaunchVersion: (value: string) => {
      launchVersion = value;
    },
    /** The next launches die with a defect, the one failure no typed handler sees. */
    dieOnLaunch: () => {
      launchDefect = true;
    },
    setDescriptorVersion: (value: string) => {
      descriptorVersion = value;
    },
    gateReadiness: (gate: NonNullable<typeof readinessGate>) => {
      readinessGate = gate;
    },
    layer: Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(NetService.NetService, testNetService),
      Layer.succeed(HttpClient.HttpClient, httpClient),
      Layer.succeed(SshAuth.SshPasswordPrompt, {
        isAvailable: true,
        request: () =>
          Effect.sync(() => {
            calls.prompts++;
            return "unused";
          }),
      }),
      SshTunnel.SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed({
          ...ARCHIVE,
          refreshOwnedRuntimeOnFirstConnection: true,
          ...runnerOptions,
        }),
        leaveRemoteServerRunning: true,
      }),
    ),
  };
};
