import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GOAT_RUNTIME_CONTROL_HEADER, GOAT_RUNTIME_DRAIN_PATH } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { restartHandStartedServer } from "./updateServerRestart.ts";

const server: PersistedServerRuntimeState = {
  version: 1,
  instanceId: "old-start",
  pid: 2_147_483_000,
  port: 3773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-11-11T00:00:00.000Z",
  serverVersion: "1.0.0",
};

const run = (
  answer: (body: unknown) => unknown,
  successor?: Partial<PersistedServerRuntimeState>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-update-restart-" });
    const statePath = path.join(home, "server-runtime.json");
    yield* fs.writeFileString(path.join(home, "runtime-control.token"), "secret\n");
    const requests: Array<{ url: string; token: string | undefined; body: unknown }> = [];
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = JSON.parse(
          new TextDecoder().decode((request.body as { body: Uint8Array }).body),
        );
        requests.push({
          url: request.url,
          token: request.headers[GOAT_RUNTIME_CONTROL_HEADER],
          body,
        });
        // The drained server's successor records itself once it owns this home.
        if (successor !== undefined)
          yield* fs.writeFileString(statePath, JSON.stringify({ ...server, ...successor }));
        return HttpClientResponse.fromWeb(request, Response.json(answer(body)));
      }).pipe(Effect.orDie),
    );
    const result = yield* restartHandStartedServer({
      server,
      serverRuntimeStatePath: statePath,
      targetVersion: "2.0.0",
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    return { result, requests };
  });

it.layer(NodeServices.layer)("goat update restarts a server started by hand", (it) => {
  it.effect(
    "asks the server to drain and start itself on the new version, then finds its successor",
    () =>
      Effect.gen(function* () {
        const { result, requests } = yield* run(
          () => ({ status: "drained", instanceId: "old-start", forced: false }),
          { instanceId: "new-start", pid: process.pid, serverVersion: "2.0.0" },
        );
        assert.deepEqual(result, { _tag: "restarted", origin: server.origin, pid: process.pid });
        assert.deepEqual(requests, [
          {
            url: `http://127.0.0.1:3773${GOAT_RUNTIME_DRAIN_PATH}`,
            token: "secret",
            body: {
              expectedInstanceId: "old-start",
              targetVersion: "2.0.0",
              graceSeconds: 60,
              force: true,
              relaunch: true,
            },
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps the manual instructions when the server cannot start itself again", () =>
    Effect.gen(function* () {
      const { result } = yield* run(() => ({
        status: "relaunch-unavailable",
        instanceId: "old-start",
        forced: false,
        reason: "The desktop app manages this server.",
      }));
      assert.deepEqual(result, {
        _tag: "unavailable",
        reason: "The desktop app manages this server.",
      });
    }).pipe(Effect.scoped),
  );
});
