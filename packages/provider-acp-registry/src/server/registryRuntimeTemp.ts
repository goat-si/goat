// @effect-diagnostics nodeBuiltinImport:off - opendir bounds the sweep without buffering a whole directory.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { AcpRegistryError, type ResolvedAcpRegistryAgent } from "./AcpRegistrySupport.ts";

const gate = Semaphore.makeUnsafe(1);
const live = new Set<string>();
const MAX_LIVE = 256;

function isDeadRun(entry: string): boolean {
  const match = /^run-(\d+)-/u.exec(entry);
  if (match === null) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function entries(directory: string, prefix?: string) {
  const result: string[] = [];
  const handle = await NodeFSP.opendir(directory);
  let scanned = 0;
  for await (const entry of handle) {
    if (++scanned > 1024) break;
    if (prefix === undefined || entry.name.startsWith(prefix)) result.push(entry.name);
    if (prefix !== undefined && result.length === 32) break;
  }
  return result;
}

export const makeRegistryRuntimeTemp = Effect.fn("AcpRegistryRuntimeTemp.make")(function* (
  root: string,
  platform: NodeJS.Platform,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(root);
  const prefix = `${path.basename(root)}.old-`;
  const retired = yield* gate.withPermits(1)(
    Effect.gen(function* () {
      if (yield* fs.exists(root)) {
        const children = yield* Effect.tryPromise(() => entries(root));
        const stale = children.filter(
          (entry) => isDeadRun(entry) && !live.has(path.join(root, entry)),
        );
        if (stale.length > 0) {
          const destination = yield* fs.makeTempDirectory({ directory: parent, prefix });
          for (const entry of stale) {
            yield* fs
              .rename(path.join(root, entry), path.join(destination, entry))
              .pipe(
                Effect.catch(() => Effect.logWarning("Could not retire ACP agent temp files.")),
              );
          }
        }
      }
      return yield* Effect.tryPromise(() => entries(parent, prefix));
    }).pipe(Effect.orElseSucceed(() => [] as string[])),
  );
  yield* Effect.forkDetach(
    Effect.forEach(
      retired,
      (entry) =>
        fs
          .remove(path.join(parent, entry), { recursive: true, force: true })
          .pipe(
            Effect.catch(() =>
              Effect.logWarning("Could not remove leftover ACP agent temp files."),
            ),
          ),
      { discard: true },
    ),
  );
  return Effect.fn("AcpRegistryRuntimeTemp.acquire")(function* (environment: NodeJS.ProcessEnv) {
    const directory = yield* Effect.acquireRelease(
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (live.size >= MAX_LIVE) {
            return yield* PlatformError.systemError({
              _tag: "Busy",
              module: "AcpRegistryRuntimeTemp",
              method: "acquire",
              description: "Too many Antigravity sessions are running.",
            });
          }
          yield* fs.makeDirectory(root, { recursive: true });
          const directory = yield* fs.makeTempDirectory({
            directory: root,
            prefix: `run-${process.pid}-`,
          });
          live.add(directory);
          return directory;
        }),
      ),
      (directory) =>
        gate.withPermits(1)(
          fs.remove(directory, { recursive: true, force: true }).pipe(
            Effect.catch(() => Effect.logWarning("Could not remove an ACP agent temp directory.")),
            Effect.ensuring(
              Effect.sync(() => {
                live.delete(directory);
              }),
            ),
          ),
        ),
    );
    if (platform !== "win32") return { ...environment, TMPDIR: directory } as NodeJS.ProcessEnv;
    const rest = Object.fromEntries(
      Object.entries(environment).filter(([key]) => !["temp", "tmp"].includes(key.toLowerCase())),
    );
    return { ...rest, TEMP: directory, TMP: directory } as NodeJS.ProcessEnv;
  });
});

export const prepareRegistryRuntimeSpawn = (
  acquire:
    | ((
        environment: NodeJS.ProcessEnv,
      ) => Effect.Effect<NodeJS.ProcessEnv, PlatformError.PlatformError, Scope.Scope>)
    | undefined,
) =>
  Effect.fn("AcpRegistryCatalog.prepareRuntimeSpawn")(function* (
    resolved: ResolvedAcpRegistryAgent,
  ) {
    if (resolved.agent?.id !== "antigravity-acp" || acquire === undefined) return resolved.spawn;
    const env = yield* acquire(resolved.spawn.env ?? {}).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "install_failed",
            detail: "Could not create a temp directory for the ACP agent.",
            cause,
          }),
      ),
    );
    return { ...resolved.spawn, env };
  });
