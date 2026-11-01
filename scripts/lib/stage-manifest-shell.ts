// @effect-diagnostics nodeBuiltinImport:off - The marker is a plain SHA-256 of the signed executable bytes.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const stageManifestShell = Effect.fn("stageManifestShell")(function* (
  contentDir: string,
  executablePath: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bytes = yield* fs.readFile(executablePath);
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  yield* fs.writeFileString(
    path.join(contentDir, "goat-manifest-shell-v1.sha256"),
    `${version} ${hash}\n`,
  );
});
