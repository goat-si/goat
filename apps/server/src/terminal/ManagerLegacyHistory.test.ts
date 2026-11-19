import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import { createManager, openInput } from "./Manager.testkit.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("TerminalManager legacy history", (it) => {
  // Case-insensitive filesystems resolve "Terminal_YQ.log" to thread "a"'s "terminal_YQ.log",
  // so the mixed-case file stands in for that alias on case-sensitive hosts.
  it.effect.each(["terminal_", "Terminal_"])(
    "never resolves a %s legacy history name to another thread's history file",
    (prefix) =>
      Effect.gen(function* () {
        const { manager, logsDir } = yield* createManager();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const threadId = `${prefix}${Base64Url.encode("a")}`;
        const otherThreadPath = path.join(logsDir, `${threadId}.log`);
        yield* fs.makeDirectory(logsDir, { recursive: true });
        yield* fs.writeFileString(otherThreadPath, "thread a\n");

        expect((yield* manager.open(openInput({ threadId }))).history).toBe("");
        yield* manager.close({ threadId, terminalId: DEFAULT_TERMINAL_ID, deleteHistory: true });
        yield* manager.close({ threadId, deleteHistory: true });

        expect(yield* fs.readFileString(otherThreadPath)).toBe("thread a\n");
      }),
  );
});
