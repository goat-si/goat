// @effect-diagnostics nodeBuiltinImport:off -- a fake control socket in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { member, PIN } from "./penDaemon.testkit.ts";
import { type PenSnapshot, watchSnapshots } from "./PenMesh.ts";

/** A control socket that answers watch.snapshot with `lines`, then holds the connection open. */
const control = (lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-pen-mesh-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const server = NodeNet.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.write(lines.map((line) => line + "\n").join("")));
    });
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(NodePath.join(dir, "control.sock"), () => resume(Effect.void));
      }),
      () => Effect.sync(() => server.close()),
    );
    return dir;
  });

const snapshot = (gen: number) =>
  JSON.stringify({
    t: "snapshot",
    gen,
    mesh: PIN.meshId,
    self: PIN.nodeId,
    members: [
      {
        nodeId: member("a"),
        signPub: "s",
        noisePub: "n",
        name: "a",
        user: "",
        hostKeys: [],
        online: true,
      },
    ],
    revoked: [],
  });

it.live(
  "follows consecutive snapshots and ends the watch at a skipped generation or a foreign line",
  () =>
    Effect.gen(function* () {
      const seen: Array<number> = [];
      const record = (value: PenSnapshot) =>
        Effect.sync(() => {
          seen.push(value.gen);
        });
      const gap = yield* control([snapshot(4), snapshot(5), snapshot(7)]);
      expect((yield* watchSnapshots(gap, record).pipe(Effect.scoped, Effect.flip)).reason).toBe(
        "the watch skipped a generation",
      );
      expect(seen).toEqual([4, 5]);
      const refused = yield* control(['{"error":"too many watchers"}']);
      expect((yield* watchSnapshots(refused, record).pipe(Effect.scoped, Effect.flip)).reason).toBe(
        "Pen sent a line that is not a snapshot",
      );
    }).pipe(Effect.scoped),
);
