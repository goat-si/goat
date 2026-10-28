import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import { ARCHIVE, uploadTarget } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";
import { launchOrReuseRemoteServer, type PreparedRemoteRuntime } from "./tunnel.ts";

export const fixture = makeProtocolFixture({
  live: true,
  kind: "managed",
  oldVersion: ARCHIVE.archiveVersion,
  commitTime: 1_700_000_000,
  ssh: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
  candidateSignals: {
    ssh: SSH_RUNTIME_PROTOCOL_VERSION,
    orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    commitTime: 1_700_000_000,
    drain: true,
  },
});
export type Fixture = Effect.Success<typeof fixture>;
export const launch = (f: Fixture, previous?: PreparedRemoteRuntime, refresh = false) =>
  launchOrReuseRemoteServer(
    uploadTarget,
    {},
    { ...f.runner, cleanupTimeoutMs: 60_000, refreshOwnedRuntimeOnFirstConnection: refresh },
    undefined,
    previous,
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, f.transport),
    Effect.provideService(FileSystem.FileSystem, f.observedFs),
  );
