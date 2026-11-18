// @effect-diagnostics nodeBuiltinImport:off - Bound filesystem signals before they enter an Effect queue.
import * as NodeFS from "node:fs";
import { guardErrors, type ErrorRoute } from "@goat/shared/errorGuards";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

type StartHeadWatch = (
  directory: string,
  notify: (event: string, filename: string | null) => void,
  onError: ErrorRoute,
) => NodeFS.FSWatcher;

export const NativeHeadWatch = Context.Reference<StartHeadWatch>("goat/vcs/NativeHeadWatch", {
  defaultValue: () => (directory, notify, onError) =>
    guardErrors(NodeFS.watch(directory, { encoding: "utf8" }, notify), onError),
});

export const watchHeadDirectory = (
  startWatch: StartHeadWatch,
  directory: string,
  onReady: () => void,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const wake = yield* Queue.sliding<void>(1);
      let headChanged = false;
      let checkDirectory = false;
      let failure: Error | undefined;
      let closed = false;
      const notify = (event: string, filename: string | null) => {
        if (closed) return;
        headChanged ||=
          filename === "HEAD" ||
          filename === null ||
          (event === "rename" && filename === "HEAD.lock");
        checkDirectory ||= event === "rename" || filename === null;
        if (headChanged || checkDirectory) Queue.offerUnsafe(wake, undefined);
      };
      const close = (watcher: NodeFS.FSWatcher) => {
        if (closed) return;
        closed = true;
        watcher.close();
      };
      const watcher = yield* Effect.acquireRelease(
        Effect.try(() =>
          startWatch(directory, notify, (error) => {
            if (closed) return;
            failure ??= error;
            checkDirectory = true;
            Queue.offerUnsafe(wake, undefined);
          }),
        ),
        (watcher) => Effect.sync(() => close(watcher)),
      );
      yield* Effect.sync(onReady);

      return Stream.fromEffectRepeat(
        Queue.take(wake).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              const changed = headChanged;
              const probe = checkDirectory;
              const error = failure;
              headChanged = false;
              checkDirectory = false;
              if (probe && !(yield* fs.exists(directory))) {
                close(watcher);
                return { changed: true, removed: true };
              }
              if (error !== undefined) return yield* Effect.fail(error);
              return { changed, removed: false };
            }),
          ),
        ),
      ).pipe(
        Stream.takeUntil(({ removed }) => removed),
        Stream.filter(({ changed }) => changed),
      );
    }),
  );
