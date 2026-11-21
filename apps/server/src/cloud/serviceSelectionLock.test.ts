import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import { acquireServiceSelectionLock } from "./serviceSelectionLock.ts";

async function attemptWithExpiredDeadline(selectionPath: string) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    const attempt = acquireServiceSelectionLock(selectionPath).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    return await attempt;
  } finally {
    vi.useRealTimers();
  }
}

it.layer(NodeServices.layer)("service selection lock", (it) => {
  it.effect("reclaims a lease from an earlier boot even when its PID is live again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");
      const lock = `${selectionPath}.selection-lock`;
      const stale = `${process.pid}.1.00000000-0000-4000-8000-000000000000`;
      yield* fs.makeDirectory(lock, { recursive: true });
      yield* fs.writeFileString(path.join(lock, stale), "");

      const release = yield* Effect.promise(() => acquireServiceSelectionLock(selectionPath));
      const owners = yield* fs.readDirectory(lock);
      assert.equal(owners.length, 1);
      assert.notEqual(owners[0], stale);
      assert.isTrue(owners[0]!.startsWith(`${process.pid}.`));
      release();
      assert.isFalse(yield* fs.exists(lock));
    }),
  );

  it.effect("reclaims a same-boot lease when its PID now belongs to another process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");
      const lock = `${selectionPath}.selection-lock`;
      const release = yield* Effect.promise(() => acquireServiceSelectionLock(selectionPath));
      const [owner] = yield* fs.readDirectory(lock);
      release();

      const [pid, boot, nonce] = (owner ?? "").split(".");
      const legacy = `${pid}.${boot}.${nonce}`;
      const stale = `${legacy}.b2xkLXByb2Nlc3M`;
      yield* fs.makeDirectory(lock, { recursive: true });
      yield* fs.writeFileString(path.join(lock, legacy), "");

      const legacyAttempt = yield* Effect.promise(() => attemptWithExpiredDeadline(selectionPath));
      assert.include(String(legacyAttempt), "Service selection is locked");
      assert.deepEqual(yield* fs.readDirectory(lock), [legacy]);
      yield* fs.rename(path.join(lock, legacy), path.join(lock, stale));

      const outcome = yield* Effect.promise(() => attemptWithExpiredDeadline(selectionPath));
      assert.isFunction(outcome, String(outcome));
      if (typeof outcome === "function") outcome();
      assert.lengthOf(owner?.split(".") ?? [], 4);
      assert.isFalse(yield* fs.exists(lock));
    }),
  );
});
