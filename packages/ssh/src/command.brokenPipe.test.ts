import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runSshCommand } from "./command.ts";
import { SshCommandError } from "./errors.ts";

// Larger than any pipe buffer, so most of it is still queued in the parent
// when the reader goes away. Runtime archives are ~70 MB.
const ARCHIVE_BYTES = 32 * 1024 * 1024;
const target = { alias: "remote", hostname: "remote", username: null, port: null };

/** Puts a fake `ssh` first on PATH; the script stands in for the remote reader. */
const withFakeSsh = (script: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped({ prefix: "goat-fake-ssh-" });
    yield* fs.writeFileString(path.join(bin, "ssh"), `#!/bin/sh\n${script}\n`);
    yield* fs.chmod(path.join(bin, "ssh"), 0o755);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = process.env.PATH;
        process.env.PATH = `${bin}:${previous ?? ""}`;
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          process.env.PATH = previous;
        }),
    );
  });

/** Collects errors that escaped every listener, which would crash `goat serve`. */
const trackUncaught = Effect.acquireRelease(
  Effect.sync(() => {
    const errors: Array<unknown> = [];
    const listener = (error: unknown) => errors.push(error);
    process.on("uncaughtException", listener);
    return { errors, listener };
  }),
  ({ listener }) => Effect.sync(() => process.off("uncaughtException", listener)),
).pipe(Effect.map(({ errors }) => errors));

// A late EPIPE is emitted from a libuv write callback after the child is gone.
// Let the event loop run those callbacks before checking for escapes.
// oxlint-disable-next-line goat/no-real-time-wait-in-tests -- Real child pipe writes can emit a late libuv EPIPE after process exit; keep the uncaught-error observation window.
const settleEventLoop = Effect.sleep("200 millis");

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("ssh stdin broken pipe", () => {
  it.live("fails only the upload when the remote reader dies mid-stream", () =>
    Effect.gen(function* () {
      yield* withFakeSsh(
        "head -c 1048576 >/dev/null\necho 'tar: Unexpected EOF in archive' >&2\nexit 2",
      );
      const uncaught = yield* trackUncaught;

      const error = yield* runSshCommand(target, {
        stdin: new Uint8Array(ARCHIVE_BYTES),
      }).pipe(Effect.flip);
      yield* settleEventLoop;

      assert.instanceOf(error, SshCommandError);
      assert.strictEqual(error.exitCode, 2);
      assert.include(error.stderr, "Unexpected EOF");
      assert.deepStrictEqual(uncaught, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("survives the reader being killed after the upload was abandoned", () =>
    Effect.gen(function* () {
      // The reader takes 1 MiB and stalls; the timeout interrupts the writer,
      // then scope cleanup kills ssh while the rest is still queued (#124).
      yield* withFakeSsh("head -c 1048576 >/dev/null\nexec sleep 30");
      const uncaught = yield* trackUncaught;

      const error = yield* runSshCommand(target, {
        stdin: new Uint8Array(ARCHIVE_BYTES),
        timeoutMs: 500,
      }).pipe(Effect.flip);
      yield* settleEventLoop;

      assert.instanceOf(error, SshCommandError);
      assert.include(error.message, "timed out");
      assert.deepStrictEqual(uncaught, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
