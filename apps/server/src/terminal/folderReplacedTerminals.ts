import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import type { TerminalSessionState } from "./Manager.ts";
import { enqueueProcessEvent, folderReplacedNotice } from "./processEventQueue.ts";

const linuxDeletedSuffix = " (deleted)";

const insideFolder = (path: Path.Path, folder: string, cwd: string) => {
  const relative = path.relative(folder, cwd);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export const makeFolderReplacedNotifier = Effect.fn("terminal.makeFolderReplacedNotifier")(
  function* (
    readState: Effect.Effect<{ readonly sessions: ReadonlyMap<string, TerminalSessionState> }>,
    drain: (session: TerminalSessionState, pid: number) => void,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const canonicalize = (cwd: string) =>
      fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
    const liveCwd = Effect.fn("terminal.liveShellCwd")(function* (pid: number) {
      if (platform === "linux") {
        const cwd = yield* fileSystem.readLink(`/proc/${pid}/cwd`);
        if (cwd.endsWith(linuxDeletedSuffix) && !(yield* fileSystem.exists(cwd)))
          return cwd.slice(0, -linuxDeletedSuffix.length);
        return cwd;
      }
      if (platform === "darwin") {
        const result = yield* processRunner.run({
          command: "lsof",
          args: ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-F0n"],
          timeout: "1 second",
          maxOutputBytes: 16_384,
          outputMode: "error",
        });
        if (result.code !== 0 || result.stdoutInvalidUtf8) return undefined;
        const field = result.stdout.split("\0").find((part) => part.startsWith("n"));
        return field?.slice(1).replace(/\\([\\nrt])/g, (escape) => {
          switch (escape) {
            case "\\n":
              return "\n";
            case "\\r":
              return "\r";
            case "\\t":
              return "\t";
            default:
              return "\\";
          }
        });
      }
      return undefined;
    });

    return Effect.fn("terminal.noticeFolderReplaced")(function* (
      folder: string,
      setAsidePath?: string | null,
    ) {
      const root = yield* canonicalize(folder);
      const aside = setAsidePath == null ? null : yield* canonicalize(setAsidePath);
      const event = { type: "output" as const, data: folderReplacedNotice(folder) };
      const { sessions } = yield* readState;
      yield* Effect.forEach(
        sessions.values(),
        (session) =>
          Effect.gen(function* () {
            const { pid, process, status } = session;
            if (pid === null || process === null || status !== "running") return;
            const live = yield* liveCwd(pid).pipe(Effect.orElseSucceed(() => undefined));
            const cwd = yield* canonicalize(
              live !== undefined && path.isAbsolute(live) ? live : session.cwd,
            );
            if (
              !insideFolder(path, root, cwd) &&
              (aside === null || !insideFolder(path, aside, cwd))
            )
              return;
            if (session.process === process && enqueueProcessEvent(session, pid, event))
              drain(session, pid);
          }),
        { concurrency: 4, discard: true },
      );
    });
  },
);
