import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import { CursorSettings } from "../settings.ts";
import * as CursorSdk from "./CursorSdk.ts";
import { makeCursorTextGeneration } from "./textGeneration.ts";

const sdk = vi.hoisted(() => ({ create: vi.fn(), prompt: vi.fn(), close: vi.fn() }));
vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({ Agent: { create: sdk.create } }),
  loadCursorSqlite: () => ({
    SqliteLocalAgentStore: { open: async () => ({ dispose: async () => {} }) },
  }),
}));
const layer = CursorSdk.layer.pipe(
  Layer.provideMerge(
    Layer.merge(
      FileSystem.layerNoop({
        exists: () => Effect.succeed(false),
        makeDirectory: () => Effect.void,
        makeTempDirectoryScoped: () => Effect.succeed("/isolated"),
      }),
      Path.layer,
    ),
  ),
);

const decodeSettings = Schema.decodeSync(CursorSettings);

describe("Cursor text generation retries", () => {
  it.effect.each(["not JSON", '{"subject":"ok","body":[]}'])(
    "retries invalid output with a fresh agent",
    (invalid) =>
      Effect.gen(function* () {
        sdk.create.mockReset();
        sdk.prompt.mockReset();
        sdk.close.mockReset();
        sdk.create.mockImplementation(async () => ({
          send: async () => ({ status: "running", cancel: async () => {}, wait: sdk.prompt }),
          [Symbol.asyncDispose]: async () => {
            sdk.close();
          },
        }));
        sdk.prompt
          .mockResolvedValueOnce({ status: "finished", result: invalid })
          .mockResolvedValueOnce({ status: "finished", result: '{"subject":"fixed","body":""}' });
        const generation = yield* makeCursorTextGeneration(decodeSettings({ enabled: true }), {
          CURSOR_API_KEY: "test",
        });
        const result = yield* generation.generateCommitMessage({
          cwd: "/work",
          branch: null,
          stagedSummary: "M a",
          stagedPatch: "diff",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "auto" },
        });
        expect(result.subject).toBe("fixed");
        expect(sdk.create).toHaveBeenCalledTimes(2);
        expect(sdk.close).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(layer)),
  );
});
