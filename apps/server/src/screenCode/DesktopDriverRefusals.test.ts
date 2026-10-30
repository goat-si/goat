import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

it.live.each([
  { code: "user_interacting", method: "click", tool: "click" },
  { code: "user_interacting", method: "observe", tool: "get_window_state" },
  { code: "screen_locked", method: "click", tool: "click" },
  { code: "screen_locked", method: "observe", tool: "get_window_state" },
])("$code stops desktop $method with a typed error", ({ code, method, tool }) => {
  const { host, sent } = fixture({
    [tool]: new DriverError({ effect: "refused", refusal: { code, retry_after_ms: 750 } }),
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
        try { await app.${method}(${method === "click" ? "{x: 1, y: 2}" : ""}); return 'success'; }
        catch (e) { return { name: e.name, code: e.code, nothingSent: e.nothingSent, effectStarted: e.effectStarted, refused: e.refused, nextStep: e.nextStep, retryClass: e.safety?.retryClass }; }`,
    });
    expect(result.value).toMatchObject({
      name: "ScreenError",
      code,
      nothingSent: true,
      effectStarted: false,
      ...(code === "user_interacting"
        ? { refused: "targetRefused", nextStep: expect.stringMatching(/750.*observe/i) }
        : { nextStep: expect.stringMatching(/unlock/i), retryClass: "never" }),
    });
    expect(sent.filter((entry) => entry.tool === tool)).toHaveLength(1);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
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
});

it.live.each(["user_interacting", "screen_locked"])(
  "%s in a verification read stops the input before it is sent",
  (code) => {
    let listings = 0;
    const { host, sent } = fixture({
      list_windows: () =>
        ++listings === 1
          ? { windows: [{ pid: 42, window_id: 7, title: "Document" }] }
          : new DriverError({ code, retry_after_ms: 750 }),
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
          try { await app.click({x: 1, y: 2, verify: true}); return 'success'; }
          catch (e) { return { code: e.code, nothingSent: e.nothingSent }; }`,
      });
      expect(result.value).toEqual({ code, nothingSent: true });
      expect(sent.some((entry) => entry.tool === "click")).toBe(false);
      yield* service.finishTurn({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
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

it.live.each(["user_interacting", "screen_locked"])(
  "%s after an input reports that the input may have landed",
  (code) => {
    let listings = 0;
    const { host, sent } = fixture({
      list_windows: () =>
        ++listings <= 2
          ? { windows: [{ pid: 42, window_id: 7, title: "Document" }] }
          : new DriverError({ code, retry_after_ms: 750 }),
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
          try { await app.click({x: 1, y: 2, verify: true}); return 'success'; }
          catch (e) { return { code: e.code, nothingSent: e.nothingSent, possibleCommit: e.safety?.possibleCommit }; }`,
      });
      expect(result.value).toEqual({ code, nothingSent: false, possibleCommit: true });
      expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(1);
      yield* service.finishTurn({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
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

it.live.each([
  { label: "observe", expression: "app.observe()" },
  { label: "query", expression: "app.observe({query: {name: 'Apply'}})" },
])("a locked accessibility tree fails $label without retrying", ({ expression }) => {
  const { host, sent } = fixture({
    get_window_state: {
      pid: 42,
      window_id: 7,
      tree_markdown: "",
      elements: [],
      degraded: true,
      degraded_reason:
        "screen_locked: window_id 7 has no accessibility tree because the screen is locked.",
      escalation: { recommended: "wait_for_unlock", reason: "Unlock the screen." },
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
      source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
        try { await ${expression}; return 'success'; }
        catch (e) { return {name: e.name, code: e.code, nothingSent: e.nothingSent, effectStarted: e.effectStarted, retryClass: e.safety?.retryClass}; }`,
    });
    expect(result.value).toEqual({
      name: "ScreenError",
      code: "screen_locked",
      nothingSent: true,
      effectStarted: false,
      retryClass: "never",
    });
    expect(sent.filter((entry) => entry.tool === "get_window_state")).toHaveLength(1);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
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
});

it.live("a screenshot-only read succeeds while the screen is locked", () => {
  const { host, sent } = fixture({
    get_window_state: {
      pid: 42,
      window_id: 7,
      tree_markdown: "",
      elements: [],
      degraded: true,
      degraded_reason:
        "screen_locked: window_id 7 has no accessibility tree because the screen is locked.",
      escalation: { recommended: "wait_for_unlock" },
      screenshot_width: 100,
      screenshot_height: 80,
      image: {
        mimeType: "image/png",
        bytes: Buffer.from("png").toString("base64"),
        width: 100,
        height: 80,
      },
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
      source:
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); return 'captured';",
    });
    expect(result.value).toBe("captured");
    expect(sent.filter((entry) => entry.tool === "get_window_state")).toHaveLength(1);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
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
});
