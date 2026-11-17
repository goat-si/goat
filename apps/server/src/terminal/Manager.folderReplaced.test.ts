import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { createManager, openInput } from "./Manager.testkit.ts";
import { folderReplacedNotice } from "./processEventQueue.ts";

// goat#3690: a shell keeps the directory it started in, so after GOAT restores or sets aside its
// folder it works in the old one. Each live terminal inside the folder is told in its own output.
it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("TerminalManager folder replaced", (it) => {
  it.effect("tells every live terminal inside a replaced folder, and no other", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-terminal-replaced-" });
      const folder = join(base, "lane");
      const sibling = join(base, "lane-other");
      for (const dir of [join(folder, "pkg"), sibling])
        yield* fs.makeDirectory(dir, { recursive: true });
      const { manager, getEvents } = yield* createManager(50);
      yield* manager.open(openInput({ threadId: "thread-1", terminalId: "root", cwd: folder }));
      yield* manager.open(
        openInput({ threadId: "thread-1", terminalId: "pkg", cwd: join(folder, "pkg") }),
      );
      // Another thread's terminal in the same folder is in the same position.
      yield* manager.open(openInput({ threadId: "thread-2", terminalId: "other", cwd: folder }));
      yield* manager.open(openInput({ threadId: "thread-1", terminalId: "sibling", cwd: sibling }));
      yield* manager.open(openInput({ threadId: "thread-1", terminalId: "closed", cwd: folder }));
      yield* manager.close({ threadId: "thread-1", terminalId: "closed" });

      yield* manager.noticeFolderReplaced(folder);

      const notice = folderReplacedNotice(folder);
      const told = (yield* getEvents)
        .flatMap((event) => (event.type === "output" && event.data === notice ? [event] : []))
        .map((event) => `${event.threadId}/${event.terminalId}`)
        .toSorted();
      assert.deepStrictEqual(told, ["thread-1/pkg", "thread-1/root", "thread-2/other"]);
      // Through the normal output path, so the saved history and agents' reads carry it.
      const reopened = yield* manager.open(
        openInput({ threadId: "thread-1", terminalId: "root", cwd: folder }),
      );
      assert.include(reopened.history, notice.trim());
    }),
  );
});
