import type { ServerConfig } from "@goat/contracts";
import type * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

export const probeCapableConfig = {
  environment: { capabilities: { connectionProbe: true } },
} as ServerConfig;

export const unusedManager = {
  status: () => Effect.die("unexpected status"),
  ensureEnvironment: () => Effect.die("unexpected ensure"),
  readyEnvironment: () => Effect.die("Unexpected ready environment"),
  beginSetupOperation: () => Effect.die("Unexpected setup operation"),
  publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
  publishSetupOutcome: () => Effect.die("Unexpected setup outcome"),
  forgetEnvironment: () => Effect.die("Unexpected forget"),
  disconnectEnvironment: () => Effect.void,
  revalidateTunnels: () => Effect.void,
  issueMcpClientSession: () => Effect.die("unexpected session"),
  issueClientSession: () => Effect.die("unexpected client session"),
  runRemoteScript: () => Effect.die("unexpected remote script"),
} satisfies SshTunnel.SshEnvironmentManagerShape;

export const successfulProcess = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
