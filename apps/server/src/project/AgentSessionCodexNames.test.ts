import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeTempDir } from "./AgentSessionScanner.testkit.ts";
import { readCodexThreadNames } from "./CodexStateDatabase.ts";

it.layer(NodeServices.layer)("Codex saved names", (it) => {
  it.effect("keeps a complete rename at the tail read boundary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeTempDir("goat-codex-names-");
      const rename = `${JSON.stringify({ id: "named-session", thread_name: "Tail rename", updated_at: "unknown" })}\n`;
      const padding = `${"x".repeat(1024 * 1024 - Buffer.byteLength(rename) - 1)}\n`;
      yield* fs.writeFileString(path.join(home, "session_index.jsonl"), `old\n${rename}${padding}`);
      expect((yield* readCodexThreadNames(home, fs, path)).get("named-session")).toBe(
        "Tail rename",
      );
    }),
  );
});
