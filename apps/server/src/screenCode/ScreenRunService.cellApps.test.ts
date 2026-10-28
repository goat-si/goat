import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnItemId, type EnvironmentId, type ProviderInstanceId } from "@goat/contracts";
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

const page = { _tag: "website", pageUrl: "https://example.test/" } as const;
const bindAndObserve = "const tab = await screen.tab({tabId: 'tab'}); await tab.observe();";
const request = {
  runId: "run",
  turnId: "turn",
  threadId: "thread",
  environmentId: "env",
  invocation,
};

/** The row a provider that keeps only a summary records for a cell that ran `code`. */
const summaryRow = (code: string, status: "completed" | "failed" = "completed") => ({
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
  status,
  title: null,
  toolName: "goat.goat_screen_run",
  input: { code },
  output: "Ran the screen cell.",
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-29T00:00:00.000Z"),
});

/** Runs `program` against a live screen runtime whose only tab is bound as "target". */
const withScreen = <A, E>(
  program: (callApps: ReturnType<typeof makeCallApps>) => Effect.Effect<A, E, ScreenRunService>,
) => {
  const callApps = makeCallApps();
  callApps.screenTarget("target", { kind: "tab", pageUrl: page.pageUrl });
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
          dispatch: (call) =>
            Effect.succeed(
              call.method === "select_tab"
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
                      tab: { tabId: "tab", title: "Page", url: page.pageUrl },
                    },
                    category: "confirmed" as const,
                  }
                : { value: { indexedText: "Page" }, category: "confirmed" as const },
            ),
        },
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
    Effect.provideService(ComputerUseCallApps, callApps),
  );
};

it.live("a cell's row names the target it acted on even when its provider keeps a summary", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const source = `${bindAndObserve} return true;`;
      const result = yield* (yield* ScreenRunService).runCell({ ...request, source });
      expect(result.value).toBe(true);
      expect(callApps.present(summaryRow(source)).toolIcon).toEqual(page);
    }),
  ),
);

it.live("a cell that fails after acting on a target still names it", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const source = `${bindAndObserve} throw new Error("boom");`;
      const result = yield* (yield* ScreenRunService).runCell({ ...request, source });
      expect(result.status).toBe("failed");
      expect(callApps.present(summaryRow(source, "failed")).toolIcon).toEqual(page);
    }),
  ),
);

it.live("a refused repeat of a cell's code does not take the earlier cell's targets", () =>
  withScreen((callApps) =>
    Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const source = `${bindAndObserve} return true;`;
      yield* service.runCell({ ...request, source });
      const refused = yield* service
        .runCell({ ...request, source, limits: { sourceBytes: 1 } })
        .pipe(Effect.flip);
      expect(refused.code).toBe("source_limit");
      const row = summaryRow(source, "failed");
      expect(callApps.present(row)).toBe(row);
    }),
  ),
);
