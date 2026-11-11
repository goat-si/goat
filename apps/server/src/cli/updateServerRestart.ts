import {
  GOAT_RUNTIME_CONTROL_HEADER,
  GOAT_RUNTIME_DRAIN_PATH,
  RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS,
  RuntimeDrainResult,
} from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  isProcessAlive,
  readPersistedServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";

/** A drained server's successor waits for the owner lock (15 seconds) before it starts. */
const SUCCESSOR_START_TIMEOUT = Duration.seconds(90);

export type HandStartedRestart =
  | { readonly _tag: "restarted"; readonly origin: string; readonly pid: number }
  | { readonly _tag: "unavailable"; readonly reason: string }
  | { readonly _tag: "stopped"; readonly reason: string };

const unavailable = (reason: string): HandStartedRestart => ({ _tag: "unavailable", reason });

/**
 * Asks a server started by hand to drain and start itself again on targetVersion. Running turns
 * get the drain's grace period; restart recovery carries any still running to the successor.
 */
export const restartHandStartedServer = Effect.fn("cli.update.restart_hand_started_server")(
  function* (input: {
    readonly server: PersistedServerRuntimeState;
    readonly serverRuntimeStatePath: string;
    readonly targetVersion: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const { server } = input;
    if (server.instanceId === undefined)
      return unavailable("This server is too old to restart itself.");
    const token = yield* fs
      .readFileString(
        path.join(path.dirname(input.serverRuntimeStatePath), "runtime-control.token"),
      )
      .pipe(
        Effect.map((value) => value.trim()),
        Effect.orElseSucceed(() => ""),
      );
    if (token === "") return unavailable("Could not read this server's runtime control token.");
    const request = HttpClientRequest.post(
      `http://127.0.0.1:${server.port}${GOAT_RUNTIME_DRAIN_PATH}`,
    ).pipe(
      HttpClientRequest.setHeader(GOAT_RUNTIME_CONTROL_HEADER, token),
      HttpClientRequest.bodyJsonUnsafe({
        expectedInstanceId: server.instanceId,
        targetVersion: input.targetVersion,
        graceSeconds: RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS,
        force: true,
        relaunch: true,
      }),
    );
    const answer = yield* http
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RuntimeDrainResult)),
        Effect.option,
      );
    if (Option.isNone(answer)) return unavailable("The server did not accept a restart request.");
    const result = answer.value;
    if (result.status === "relaunch-unavailable")
      return unavailable(result.reason ?? "The server cannot restart itself.");
    if (result.status !== "drained")
      return unavailable("The server changed or kept running turns while it was asked to stop.");
    const successor = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
      Effect.filterOrFail(
        (state) =>
          state !== undefined &&
          state.pid !== server.pid &&
          state.serverVersion === input.targetVersion &&
          isProcessAlive(state.pid),
      ),
      Effect.retry(Schedule.spaced("500 millis")),
      Effect.timeoutOption(SUCCESSOR_START_TIMEOUT),
    );
    if (Option.isNone(successor) || successor.value === undefined)
      return {
        _tag: "stopped",
        reason: `The server stopped, but GOAT ${input.targetVersion} did not report it was running within ${Duration.format(SUCCESSOR_START_TIMEOUT)}.`,
      } satisfies HandStartedRestart;
    return {
      _tag: "restarted",
      origin: successor.value.origin,
      pid: successor.value.pid,
    } satisfies HandStartedRestart;
  },
);
