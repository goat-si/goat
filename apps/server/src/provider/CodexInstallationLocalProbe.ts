import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Version } from "./CodexInstallationRelease.ts";

const Probe = Schema.fromJsonString(
  Schema.Struct({
    executablePath: Schema.String,
    fingerprint: Schema.String,
    version: Version,
  }),
);
const Package = Schema.fromJsonString(
  Schema.Struct({ name: Schema.Literal("@openai/codex"), version: Schema.String }),
);
const encodeProbe = Schema.encodeEffect(Probe);
const decodeProbe = Schema.decodeEffect(Probe);
const decodePackage = Schema.decodeEffect(Package);

export const makeLocalProbeCache = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  platform: NodeJS.Platform,
  baseDir: string,
) => {
  // Native Codex needs its adjacent host; launchers resolve their own payloads.
  const localKind = Effect.fn("CodexInstallation.localKind")(
    function* (realExecutablePath: string) {
      if (/^(?:volta-shim|mise|aqua-proxy)(?:\.exe)?$/iu.test(path.basename(realExecutablePath)))
        return "launcher";
      if (platform === "win32") {
        if (path.extname(realExecutablePath).toLowerCase() !== ".exe") return "launcher";
        for (const extension of [".bunx", ".shim"]) {
          const marker = yield* fs
            .stat(realExecutablePath.slice(0, -4) + extension)
            .pipe(Effect.option);
          if (
            Option.isSome(marker) &&
            marker.value.type === "File" &&
            Number(marker.value.size) > 0
          )
            return "launcher";
        }
      } else {
        const header = yield* fs.open(realExecutablePath, { flag: "r" }).pipe(
          Effect.flatMap((file) => file.readAlloc(2)),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isSome(header) && header.value[0] === 0x23 && header.value[1] === 0x21)
          return "launcher";
      }
      const info = yield* fs.stat(
        path.join(
          path.dirname(realExecutablePath),
          `codex-code-mode-host${platform === "win32" ? ".exe" : ""}`,
        ),
      );
      return info.type === "File" &&
        Number(info.size) > 0 &&
        (platform === "win32" || (info.mode & 0o111) !== 0)
        ? "native"
        : null;
    },
    Effect.scoped,
    Effect.orElseSucceed(() => null),
  );

  const probePath = path.join(baseDir, "caches", "codex-local-probe.json");
  const fingerprint = Effect.fn("CodexInstallation.localFingerprint")(function* (
    executablePath: string,
    realExecutablePath: string,
  ) {
    const kind = yield* localKind(realExecutablePath);
    if (kind === null) return null;
    let npmVersion: string | null = null;
    if (kind === "launcher") {
      for (const manifest of [
        path.join(path.dirname(executablePath), "node_modules", "@openai", "codex", "package.json"),
        path.join(path.dirname(realExecutablePath), "..", "package.json"),
      ]) {
        const result = yield* fs
          .readFileString(manifest)
          .pipe(Effect.flatMap(decodePackage), Effect.option);
        if (Option.isSome(result)) {
          npmVersion = result.value.version;
          break;
        }
      }
    }
    const info = yield* fs.stat(executablePath);
    return {
      fingerprint: `${realExecutablePath}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}:${Option.getOrUndefined(info.ino)}:${npmVersion ?? ""}`,
      persists: kind === "native" || npmVersion !== null,
    };
  });
  const read = (executablePath: string, fingerprint: string) =>
    fs.readFileString(probePath).pipe(
      Effect.flatMap(decodeProbe),
      Effect.map((record) =>
        record.executablePath === executablePath && record.fingerprint === fingerprint
          ? record.version
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );
  const write = (executablePath: string, fingerprint: string, version: string) =>
    fs.makeDirectory(path.dirname(probePath), { recursive: true }).pipe(
      Effect.andThen(encodeProbe({ executablePath, fingerprint, version })),
      Effect.flatMap((record) => fs.writeFileString(probePath, record)),
      Effect.ignore,
    );
  return { fingerprint, read, write };
};
