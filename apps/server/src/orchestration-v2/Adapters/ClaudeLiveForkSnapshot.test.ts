// @effect-diagnostics-next-line nodeBuiltinImport:off -- write a real SDK transcript fixture.
import * as NodeFS from "node:fs";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { ProviderSessionId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import { ProviderEventLoggers } from "@goat/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ClaudeAgentSdkQueryRunner, layerQueryRunner } from "./ClaudeAgentSdkQueryRunner.ts";

it.live("SDK fork remains at its inclusive boundary while the source transcript grows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* fs.makeTempDirectoryScoped({ prefix: "goat-live-fork-" });
      const dir = path.join(config, "projects", "-repo");
      yield* fs.makeDirectory(dir, { recursive: true });
      const session = "11111111-1111-4111-8111-111111111111";
      const ids = [
        "aaaaaaaa-0000-4000-8000-000000000001",
        "aaaaaaaa-0000-4000-8000-000000000002",
        "aaaaaaaa-0000-4000-8000-000000000003",
        "aaaaaaaa-0000-4000-8000-000000000004",
      ];
      const entry = (i: number, text: string) =>
        JSON.stringify({
          type: i % 2 === 0 ? "user" : "assistant",
          uuid: ids[i],
          parentUuid: i === 0 ? null : ids[i - 1],
          sessionId: session,
          cwd: "/repo",
          isSidechain: false,
          timestamp: "2026-10-01T00:00:00.000Z",
          message: { role: i % 2 === 0 ? "user" : "assistant", content: text },
        }) + "\n";
      const source = path.join(dir, `${session}.jsonl`);
      yield* fs.writeFileString(
        source,
        entry(0, "first") + entry(1, "boundary") + entry(2, "later question"),
      );
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const fork = yield* runner
        .forkSession({
          sessionId: session,
          options: { dir: "/repo", upToMessageId: ids[1]! },
          environment: { CLAUDE_CONFIG_DIR: config, HOME: config, PATH: "/usr/bin:/bin" },
          threadId: ThreadId.make("snapshot-fork"),
          providerSessionId: ProviderSessionId.make("snapshot-fork"),
        })
        .pipe(Effect.forkChild);
      yield* Effect.sync(() => NodeFS.appendFileSync(source, entry(3, "later answer")));
      const result = yield* Fiber.join(fork);
      const transcript = yield* fs.readFileString(path.join(dir, `${result.sessionId}.jsonl`));
      assert.include(transcript, "boundary");
      assert.notInclude(transcript, "later question");
      assert.notInclude(transcript, "later answer");
      assert.include(yield* fs.readFileString(source), "later answer");
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
          ),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
