import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import * as SiteNotes from "../preview/SiteNotes.ts";
import { runMigrations } from "../persistence/Migrations.ts";

const invocation = {
  environmentId: "env" as EnvironmentId,
  capabilities: new Set<"preview">(),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: "thread" as ThreadId,
    providerSessionId: "s",
    providerInstanceId: "p" as ProviderInstanceId,
  },
};

it.live("a tab binding receives a saved note once across cells", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* Effect.gen(function* () {
      const notes = yield* SiteNotes.SiteNotes;
      yield* notes.write({
        origin: "https://example.test",
        text: "saved procedure",
        author: "person",
      });
      const targetRef = {
        id: "target",
        kind: "tab" as const,
        environmentId: "env",
        runId: "r",
        turnId: "t",
        generation: 0,
      };
      const dispatcher = {
        availability: () => Effect.succeed([{ kind: "tab" as const, available: true }]),
        dispatch: (call: { method: string }) =>
          Effect.succeed({
            value:
              call.method === "select_tab"
                ? { targetRef, tab: { tabId: "tab", title: "Page", url: "https://example.test/" } }
                : { url: "https://example.test/page", text: "page" },
            category: "confirmed" as const,
          }),
      };
      yield* Effect.gen(function* () {
        const service = yield* ScreenRunService;
        const request = {
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation: {
            ...invocation,
            capabilities: new Set(["preview" as const]),
            reauthorize: () => Effect.void,
          },
        };
        const first = yield* service.runCell({
          ...request,
          source:
            "const tab = await screen.tab({tabId: 'tab'}); await tab.read(); return tab.note;",
        });
        expect(first.value).toContain("saved procedure");
        const second = yield* service.runCell({
          ...request,
          source: "return (await screen.tab({tabId: 'tab'})).note ?? null;",
        });
        expect(second.value).toBeNull();
        yield* service.finishTurn({ ...request, reason: "test" });
      }).pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            dispatcher,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    }).pipe(Effect.provide(SiteNotes.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.live("a tab read after navigation delivers the current origin note", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* Effect.gen(function* () {
      const notes = yield* SiteNotes.SiteNotes;
      yield* notes.write({
        origin: "https://next.example",
        text: "next procedure",
        author: "person",
      });
      const targetRef = {
        id: "target",
        kind: "tab" as const,
        environmentId: "env",
        runId: "r",
        turnId: "t",
        generation: 0,
      };
      const dispatcher = {
        availability: () => Effect.succeed([{ kind: "tab" as const, available: true }]),
        dispatch: (call: { method: string }) =>
          Effect.succeed({
            value:
              call.method === "select_tab"
                ? { targetRef, tab: { tabId: "tab", title: "Page", url: "https://first.example/" } }
                : { url: "https://next.example/page", text: "page" },
            category: "confirmed" as const,
          }),
      };
      yield* Effect.gen(function* () {
        const service = yield* ScreenRunService;
        const request = {
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation: {
            ...invocation,
            capabilities: new Set(["preview" as const]),
            reauthorize: () => Effect.void,
          },
        };
        const result = yield* service.runCell({
          ...request,
          source:
            "const tab = await screen.tab({tabId: 'tab'}); await tab.read(); return tab.note;",
        });
        expect(result.value).toContain("next procedure");
        expect(notes.hasTouched("thread", "https://next.example")).toBe(true);
        yield* service.finishTurn({ ...request, reason: "test" });
      }).pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            dispatcher,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    }).pipe(Effect.provide(SiteNotes.layer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
