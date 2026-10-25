import type { OrchestratorMcpFailure } from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stable hash of managed SSH files, never credentials.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

/**
 * "ready": a setup finished with the runtime ready and its providers diagnosed. "forgotten": a
 * Forget began, before its runtime teardown and file removal. A failure answering "forgotten"
 * stops that Forget, so state bound to the alias is never left behind for a later Add.
 */
export type SshAliasEvent = "ready" | "forgotten";
export type SshAliasListener = (
  host: string,
  event: SshAliasEvent,
) => Effect.Effect<void, OrchestratorMcpFailure>;

/**
 * Identifies one managed alias's config and pinned key. Forget and a new Add rewrite the config,
 * so the value changes even for the same name and machine; undefined once the config is gone.
 */
export type SshAliasRevision = (
  host: string,
) => Effect.Effect<string | undefined, PlatformError.PlatformError>;

export const managedAliasRevision =
  (fs: FileSystem.FileSystem, path: Path.Path, directory: string): SshAliasRevision =>
  (host) =>
    Effect.gen(function* () {
      const readOptional = (file: string) =>
        fs.readFileString(file).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
          }),
        );
      const conf = yield* readOptional(path.join(directory, `${host}.conf`));
      if (conf === null) return undefined;
      const pin = yield* readOptional(path.join(directory, `${host}.known_hosts`));
      const metadata = yield* fs.stat(path.join(directory, `${host}.conf`));
      return NodeCrypto.createHash("sha256")
        .update(`${conf}\0${pin ?? ""}\0${Option.getOrNull(metadata.mtime)?.getTime() ?? ""}`)
        .digest("hex");
    });
