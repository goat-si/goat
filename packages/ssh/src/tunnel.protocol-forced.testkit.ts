import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import { buildRemoteRuntimeProbeScript, decodeRemoteRuntimeProbe } from "./runtimeProbe.ts";
import { ARCHIVE, remoteShell } from "./tunnel.fixture.ts";
import type { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type Fixture = Effect.Success<ReturnType<typeof makeProtocolFixture>>;

/** The start time the host reports for a PID, as a person approved it. */
export const startOf = (f: Pick<Fixture, "realSpawner">, pid: number) =>
  Effect.gen(function* () {
    const ps = yield* f.realSpawner.spawn(
      ChildProcess.make("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { LC_ALL: "C", TZ: "UTC" },
        extendEnv: false,
      }),
    );
    const text = yield* ps.stdout.pipe(Stream.decodeText(), Stream.mkString);
    return text.trim().replace(/\s+/gu, " ");
  });

export const events = (f: Pick<Fixture, "fs" | "test">) =>
  f.fs.readFileString(`${f.test}/events`).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; version: string }),
    ),
  );

/** A managed runtime whose descriptor does not answer, as GOAT 0.1.6 did on 2026-11-11. */
export const unverified = {
  live: true,
  kind: "managed",
  oldVersion: "1.2.2",
  ssh: 99,
  orchestration: ORCHESTRATION_PROTOCOL_VERSION,
  descriptor404: true,
} as const;

/** Runs the status probe on the fixture host, as the status read does. */
export const statusProbe = (f: Pick<Fixture, "realSpawner" | "home">) =>
  Effect.gen(function* () {
    const probe = yield* f.realSpawner.spawn(
      ChildProcess.make(remoteShell, ["-s"], {
        env: {
          HOME: f.home,
          PATH: `${f.home}/.test/identity-bin:${process.env.PATH ?? ""}`,
          LC_ALL: "C",
        },
        extendEnv: false,
        stdin: {
          stream: Stream.make(
            new TextEncoder().encode(
              buildRemoteRuntimeProbeScript(
                ARCHIVE.archiveVersion,
                REMOTE_RUNTIME_STATE_KEY,
                false,
                false,
                undefined,
                true,
              ),
            ),
          ),
          endOnDone: true,
        },
      }),
    );
    const output = yield* probe.stdout.pipe(Stream.decodeText(), Stream.mkString);
    return yield* decodeRemoteRuntimeProbe(output);
  });
