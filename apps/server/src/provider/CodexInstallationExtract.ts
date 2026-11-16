import { cliArchiveTarCommand } from "@goat/shared/cliRelease";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import { type CodexInstallationError, installationError } from "./CodexInstallationRelease.ts";

/** The unpacked package's ceiling; the CLI, its code-mode host and rg are far smaller. */
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
/**
 * A real package has a handful of members and unpacks in seconds. Each member re-reads the whole
 * archive, so a package of thousands of members could keep tar busy for hours without this.
 */
const EXTRACT_DEADLINE = "10 minutes";

/**
 * Unpacks a verified Codex package into runtime. Every member is streamed out of tar one at a time
 * and counted, so a package that inflates past the ceiling stops while it is being written, and
 * the whole extraction has one deadline.
 */
export const extractCodexPackage = Effect.fn("CodexInstallation.extract")(
  function* (input: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<string, CodexInstallationError | PlatformError.PlatformError>;
    readonly archivePath: string;
    readonly runtime: string;
    readonly maxExtractedBytes?: number;
  }) {
    const { fs, path, archivePath, runtime } = input;
    // Bare `tar` on Windows can resolve to Git's MSYS tar, which reads `C:\...` as a remote host.
    const tar = cliArchiveTarCommand(input.platform, input.environment);
    const entries = (yield* input.run(tar, ["-tzf", archivePath])).trim().split(/\r?\n/u);
    const types = (yield* input.run(tar, ["-tvzf", archivePath])).trim().split(/\r?\n/u);
    if (
      entries.length > 10000 ||
      entries.length !== types.length ||
      types.some((line) => !["-", "d"].includes(line[0] ?? "")) ||
      entries.some((entry) => {
        const parts = entry.replace(/\/$/u, "").split("/");
        return (
          !entry ||
          entry.includes("\\") ||
          entry.startsWith("/") ||
          // tar reads these as options or patterns.
          entry.startsWith("-") ||
          /[*?[]/u.test(entry) ||
          parts.some((part) => part === ".." || part === "." || part === "" || part.includes(":"))
        );
      })
    )
      return yield* installationError("extract", "The Codex archive contains unsafe entries.");
    const limit = input.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
    let extractedBytes = 0;
    for (const [index, entry] of entries.entries()) {
      const type = types[index] ?? "";
      const target = path.join(runtime, ...entry.replace(/\/$/u, "").split("/"));
      if (type.startsWith("d")) {
        yield* fs.makeDirectory(target, { recursive: true });
        continue;
      }
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* Effect.gen(function* () {
        const child = yield* input.spawner.spawn(
          ChildProcess.make(tar, ["-xOzf", archivePath, "--", entry], {
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        yield* child.stdout.pipe(
          Stream.tap((chunk) =>
            Effect.suspend(() => {
              extractedBytes += chunk.byteLength;
              return extractedBytes > limit
                ? installationError(
                    "extract",
                    "The Codex package exceeded its unpacked size limit. Nothing was installed.",
                  )
                : Effect.void;
            }),
          ),
          Stream.run(
            fs.sink(target, { flag: "wx", mode: type.slice(1, 10).includes("x") ? 0o755 : 0o644 }),
          ),
        );
        if ((yield* child.exitCode) !== 0)
          return yield* installationError("extract", "Could not unpack the Codex package.");
      }).pipe(Effect.scoped);
    }
  },
  Effect.timeout(EXTRACT_DEADLINE),
  Effect.catchTags({
    TimeoutError: () =>
      installationError("extract", "Unpacking Codex took too long. Nothing was installed."),
  }),
);
