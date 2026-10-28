import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ThreadId,
  TurnItemId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ScreenHostCall,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";

import { ComputerUseCallApps, makeCallApps } from "../cua/ComputerUseCallApps.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const invocation = {
  environmentId: "env" as EnvironmentId,
  capabilities: new Set(["preview" as const]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: "thread" as ThreadId,
    providerSessionId: "s",
    providerInstanceId: "p" as ProviderInstanceId,
  },
  reauthorize: () => Effect.void,
};
const request = {
  runId: "run",
  turnId: "turn",
  threadId: "thread",
  environmentId: "env",
  invocation,
};
const bind = "const tab = await screen.tab({tabId: 'tab'});";

/** The row a provider records for a cell whose output names `cellId`. */
const rowFor = (cellId: string | undefined) => ({
  id: TurnItemId.make("cell-row"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "goat screen run",
  toolName: "mcp__goat__goat_screen_run",
  input: { code: "..." },
  output: { cellId },
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-29T00:00:00.000Z"),
});

/**
 * Runs `program` against a live screen runtime with one tab bound as "target", relabelled on each
 * call and after a navigation inside the calling cell, as PreviewTargetHost does.
 */
const withScreen = <A, E>(
  program: (callApps: ReturnType<typeof makeCallApps>) => Effect.Effect<A, E, ScreenRunService>,
) => {
  const callApps = makeCallApps();
  let url = "https://www.example.com/";
  const label = (cell: { runId: string; turnId: string; cellId: string }) =>
    callApps.screenTarget("target", { kind: "tab", pageUrl: url }, cell);
  const arg = (call: ScreenHostCall) =>
    (Array.isArray(call.args) ? call.args[0] : undefined) as { url?: string } | undefined;
  return program(callApps).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        dispatcher: {
          availability: () => Effect.succeed([{ kind: "tab", available: true }]),
          dispatch: (call, context) =>
            call.method === "click"
              ? Effect.fail({
                  code: "target_missing" as const,
                  effectStarted: false,
                  nextStep: "Observe again.",
                })
              : Effect.sync(() => {
                  label(context);
                  if (call.method === "navigate_tab") {
                    url = arg(call)?.url ?? url;
                    label(context);
                  }
                  return call.method === "select_tab"
                    ? {
                        value: {
                          targetRef: {
                            id: "target",
                            kind: "tab" as const,
                            environmentId: "env",
                            runId: "run",
                            turnId: "turn",
                            generation: 0,
                          },
                          tab: { tabId: "tab", title: "Page", url },
                        },
                        category: "confirmed" as const,
                        evidence: ["test"],
                      }
                    : {
                        value: { indexedText: "Page" },
                        category: "confirmed" as const,
                        evidence: ["test"],
                      };
                }),
        },
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
    Effect.provideService(ComputerUseCallApps, callApps),
  );
};

it.live("a cell's row says where it acted and what it did, never what it typed", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const result = yield* (yield* ScreenRunService).runCell({
        ...request,
        source: `${bind} await tab.type("hunter2"); await tab.press("Enter"); return true;`,
      });
      const row = callApps.present(rowFor(result.cellId));
      expect(row.title).toBe("example.com · type, press Enter");
      const summary = row.type === "dynamic_tool" ? row.toolSummary : undefined;
      expect(summary).toMatch(/^3 confirmed · \d+(?: ms|\.?\d* s)$/u);
      expect(JSON.stringify(row)).not.toContain("hunter2");
    }),
  ),
);

it.live("a tab that went from one site to another names both", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const result = yield* (yield* ScreenRunService).runCell({
        ...request,
        source: `${bind} await tab.goto("https://news.example.org/a"); await tab.observe(); return true;`,
      });
      expect(callApps.present(rowFor(result.cellId)).title).toBe(
        "example.com + example.org · open",
      );
    }),
  ),
);

it.live("a cell that fails names its cell and counts every receipt", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const result = yield* (yield* ScreenRunService).runCell({
        ...request,
        source: `${bind} for (let i = 0; i < 20; i++) await tab.observe(); throw new Error("boom");`,
      });
      expect(result.status).toBe("failed");
      const row = callApps.present(rowFor(result.cellId));
      expect(row.title).toBe("example.com · observe · failed");
      expect(row.type === "dynamic_tool" ? row.toolSummary : "").toMatch(/^21 confirmed · /u);
    }),
  ),
);

it.live("a cell stopped at its wall limit is tagged with that limit", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const result = yield* (yield* ScreenRunService).runCell({
        ...request,
        source: `${bind} await tab.observe(); while (true) {}`,
        limits: { cellWallMs: 1_000 },
      });
      expect(result.status).toBe("deadline");
      expect(callApps.present(rowFor(result.cellId)).title).toBe(
        "example.com · observe · deadline 1 s",
      );
    }),
  ),
);

it.live("a cell that fails on a host refusal names its cell in the error and its row says so", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const error = yield* (yield* ScreenRunService)
        .runCell({ ...request, source: `${bind} await tab.observe(); await tab.click("Save");` })
        .pipe(Effect.flip);
      expect(error.code).toBe("target_missing");
      const cellId = "cellId" in error ? error.cellId : undefined;
      expect(cellId).toBeTypeOf("string");
      expect(callApps.present(rowFor(cellId)).title).toBe(
        "example.com · click · failed · 1 refused",
      );
    }),
  ),
);
