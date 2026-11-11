// @effect-diagnostics nodeBuiltinImport:off -- the socket directory check needs lstat ownership and mode bits.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { CodexDetachedAppServerError } from "./CodexDetachedAppServerError.ts";

/** Runs as the detached group leader: publishes its pid with link(2), then execs Codex in place. */
export const PID_HANDSHAKE_SCRIPT =
  'printf %s "$$" > "$1.$$" && ln "$1.$$" "$1" || { rm -f "$1.$$"; exit 75; }; rm -f "$1.$$"; shift; exec "$@"';

/** Creates root/codex with mode 0700 and refuses a directory another user could write to. */
export const privateSocketDirectory = (root: string, uid: number) =>
  Effect.tryPromise({
    try: async () => {
      const directory = NodePath.join(root, "codex");
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      for (const path of [root, directory]) {
        const stat = await NodeFSP.lstat(path);
        if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
          throw new Error(path + " must be a private directory owned by this user.");
      }
      return directory;
    },
    catch: (cause) =>
      new CodexDetachedAppServerError({
        detail: "The Codex socket directory is not private.",
        cause,
      }),
  });
