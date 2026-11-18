// @effect-diagnostics nodeBuiltinImport:off - Runs the CLI against an isolated home.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@goat/contracts";
import { guardChild } from "@goat/shared/errorGuards";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import { tryAcquireServerOwnerLock } from "../serverOwnerLockFile.ts";

const startBlockedTrial = (trialOwnerRefusal: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-trial-ownership-" });
    const stateDir = path.join(home, "userdata");
    yield* fs.makeDirectory(stateDir);
    const lock = tryAcquireServerOwnerLock(stateDir, "server:desktop");
    assert.isDefined(lock);
    yield* Effect.addFinalizer(() => Effect.sync(() => lock?.release()));
    const first = Promise.withResolvers<number | "waiting" | null>();
    const closed = Promise.withResolvers<void>();
    const child = guardChild(
      NodeChildProcess.spawn(
        process.execPath,
        [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), "serve", "--base-dir", home],
        {
          env: {
            ...process.env,
            GOAT_HOME: home,
            [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              childVersion: "1.1.0",
              ...(trialOwnerRefusal ? { trialOwnerRefusal: true } : {}),
              update: {
                id: "trial",
                fromVersion: "1.0.0",
                targetVersion: "1.1.0",
                dbPath: path.join(stateDir, "statev2.sqlite"),
                status: "pending",
              },
            }),
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      ),
      first.reject,
    );
    child.once("close", (code) => {
      first.resolve(code);
      closed.resolve();
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        return closed.promise;
      }),
    );
    let output = "";
    const observe = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4_096);
      if (output.includes("Waiting for the GOAT server using this data to exit")) {
        first.resolve("waiting");
      }
    };
    assert.isNotNull(child.stdout);
    assert.isNotNull(child.stderr);
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    const outcome = yield* Effect.promise(() => first.promise);
    return { outcome, output };
  });

describe("ownership of a home during a managed CLI trial", () => {
  it.live("returns exit 78 to a launcher that handles trial ownership waits", () =>
    Effect.gen(function* () {
      const { outcome, output } = yield* startBlockedTrial(true);
      assert.equal(outcome, SERVER_EXIT_CODE_STATE_DIR_OWNED, output);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("keeps waiting under an older launcher", () =>
    Effect.gen(function* () {
      const { outcome, output } = yield* startBlockedTrial(false);
      assert.equal(outcome, "waiting", output);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
