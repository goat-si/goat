import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";

it.live("an unchanged app observation returned by a cell fits 450 bytes", () => {
  let reads = 0;
  const { host } = fixture({
    click: { effect: "unverifiable" },
    get_window_state: (args: Record<string, unknown>) => {
      const old = goat2WindowState(args);
      const snapshot = `s${++reads}`;
      const full = {
        ...old,
        snapshot_id: snapshot,
        elements:
          "elements" in old
            ? old.elements?.map((item) => ({
                ...item,
                element_token: `${snapshot}:${item.element_index}`,
                ...(item.element_index === 1 ? { frame: { x: 10, y: 20, w: 30, h: 40 } } : {}),
              }))
            : undefined,
      };
      if (args.since === undefined) return full;
      return {
        ...full,
        since_status: reads === 3 ? "diff" : "no_change",
        tree_diff: reads === 3 ? '~ [1] AXButton "Apply"' : `no change since ${args.since}`,
      };
    },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "run:thread:12345678-1234-1234-1234-123456789012:ordinal:1",
      turnId: "turn:12345678-1234-1234-1234-123456789012",
      threadId: "12345678-1234-1234-1234-123456789012",
      environmentId: "12345678-1234-1234-1234-123456789012",
      invocation: context.invocation,
      source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7});
        await app.observe(); await app.click(1); const unchanged = await app.observe(); const changed = await app.observe(); return {unchanged, changed};`,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const value = result.value as {
      unchanged: { effect?: string; omitted?: unknown[] };
      changed: unknown;
    };
    const bytes = Buffer.byteLength(JSON.stringify(value.unchanged));
    console.log(
      `unchanged observation bytes: ${bytes}; one-row diff bytes: ${Buffer.byteLength(JSON.stringify(value.changed))}`,
    );
    expect(bytes, `unchanged observation bytes: ${bytes}`).toBeLessThanOrEqual(450);
    expect(value.unchanged.effect).toBe("after click: no change in this window");
    expect(value.unchanged.omitted).toContainEqual({ kind: "frames" });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live(
  "observation properties remain readable while copies omit metadata and debug exposes it",
  () => {
    const base = fixture({ get_window_state: goat2WindowState });
    const channel = {
      request: (request: Parameters<typeof base.channel.request>[0]) =>
        base.channel.request(request).pipe(
          Effect.map((reply) => ({
            ...reply,
            ...(request.tool === "get_window_state" ? { hops: { queueMs: 1 } } : {}),
          })),
        ),
    } as ComputerUsePrimitiveChannel["Service"];
    const host = createDesktopTargetHost({
      primitiveChannel: channel,
      leases: base.leases,
      platform: "darwin",
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "run:12345678-1234-1234-1234-123456789012",
        turnId: "turn:12345678-1234-1234-1234-123456789012",
        threadId: "12345678-1234-1234-1234-123456789012",
        environmentId: "12345678-1234-1234-1234-123456789012",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7});
        const obs = await app.observe(); screen.values.obs = obs;
        const names = ['targetRef', 'targetGeneration', 'surfaceGeneration', 'phases'];
        const direct = [typeof obs.targetRef.id, typeof obs.targetGeneration, typeof obs.surfaceGeneration, typeof obs.phases, typeof obs.indexedText];
        const copies = [{...obs}, JSON.parse(JSON.stringify(obs)), screen.values.obs].map(copy => names.map(k => k in copy));
        screen.debug = true; const debug = await app.observe();
        return {direct, copies, noHops: !('hops' in obs.phases), debugHops: debug.phases.hops?.queueMs, debug: names.map(k => Object.keys(debug).includes(k))};`,
      });
      expect(result).toMatchObject({
        status: "completed",
        value: {
          direct: ["string", "number", "number", "object", "string"],
          copies: Array.from({ length: 3 }, () => [false, false, false, false]),
          debug: [true, true, true, true],
          noHops: true,
          debugHops: 1,
        },
      });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

it.live("repeated frame omissions keep their kind and omit only the repeated detail", () => {
  let reads = 0;
  const { host } = fixture({
    get_window_state: (args: Record<string, unknown>) => {
      const old = goat2WindowState(args);
      const snapshot = `s${++reads}`;
      const full = {
        ...old,
        snapshot_id: snapshot,
        elements:
          "elements" in old
            ? old.elements?.map((item) => ({
                ...item,
                element_token: `${snapshot}:${item.element_index}`,
                ...(item.element_index === 1 ? { frame: { x: 10, y: 20, w: 30, h: 40 } } : {}),
              }))
            : undefined,
      };
      return args.since === undefined
        ? full
        : {
            ...full,
            since_status: "no_change",
            tree_diff: `no change since ${args.since}`,
          };
    },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7});
        const first = await app.observe(); const second = await app.observe(); const third = await app.observe();
        return [first.omitted, second.omitted, third.omitted];`,
    });
    const value = result.value as Array<Array<{ kind: string; detail?: string }>>;
    expect(result.status).toBe("completed");
    expect(value[0]).toContainEqual({
      kind: "frames",
      detail: expect.stringContaining("Frames left out"),
    });
    expect(value[1]).toContainEqual({ kind: "frames" });
    expect(value[2]).toContainEqual({ kind: "frames" });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});
