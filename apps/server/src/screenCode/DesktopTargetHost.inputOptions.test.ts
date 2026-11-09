import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { prepareDesktopInput } from "./DesktopInputPlan.ts";
import type { BoundWindow } from "./DesktopTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

const state = {
  pid: 42,
  window_id: 7,
  snapshot_id: "snapshot",
  elements_complete: true,
  tree_markdown: '- [1] AXButton "Apply" [actions=[press,move next]]',
  elements: [
    {
      element_index: 1,
      element_token: "snapshot:1",
      role: "AXButton",
      label: "Apply",
      actions: ["AXPress", "name:move next\ntarget:0x0\nselector:(null)"],
    },
  ],
};
const bind =
  "const app = await screen.app({bundle_id:'org.example.Editor', window_id:7}); await app.observe(); ";
const run = (source: string, host: ReturnType<typeof fixture>["host"]) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    return yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: bind + source,
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

it.live(
  "app click forwards modifiers alone and in a group, and refuses invalid modifiers unsent",
  () => {
    const { host, sent } = fixture({ get_window_state: state });
    return Effect.gen(function* () {
      const result = yield* run(
        `await app.click(1, {modifiers:['cmd','shift','alt','ctrl']});
      await Promise.all([app.click(1, {modifiers:['shift']}), app.click(1, {modifiers:['alt']})]);
      try { await app.click(1, {modifiers:['bad']}); } catch(e) { return [e.code, e.nothingSent]; }`,
        host,
      );
      expect(result.value).toEqual(["invalid_argument", true]);
      expect(
        sent.filter((entry) => entry.tool === "click").map((entry) => entry.args),
      ).toMatchObject([
        { modifier: ["command", "shift", "option", "control"] },
        { modifier: ["shift"] },
        { modifier: ["option"] },
      ]);
    });
  },
);

it.live(
  "app press validates hold duration and refuses it unsent when the pinned driver lacks support",
  () => {
    const { host, sent } = fixture({ get_window_state: state });
    return Effect.gen(function* () {
      const result = yield* run(
        `const results=[]; for (const holdMs of [-1, 1.5, 30001, 10]) {
      try { await app.press('Enter', 1, {holdMs}); results.push('sent'); }
      catch(e) { results.push([e.code, e.nothingSent, e.nextStep]); }
    } return results;`,
        host,
      );
      expect(result.value).toEqual([
        ["invalid_argument", true, null],
        ["invalid_argument", true, null],
        ["invalid_argument", true, null],
        ["unsupported", true, expect.stringMatching(/driver/i)],
      ]);
      expect(sent.filter((entry) => entry.tool === "press_key")).toHaveLength(0);
    });
  },
);

it.live(
  "app click accepts advertised raw and displayed actions and names available actions on refusal",
  () => {
    const { host, sent } = fixture({ get_window_state: state });
    return Effect.gen(function* () {
      const result = yield* run(
        `await app.click(1, {action:'move next'}); await app.click(1, {action:'AXPress'});
      try { await app.click(1, {action:'missing'}); } catch(e) { return [e.code, e.nothingSent, e.nextStep]; }`,
        host,
      );
      expect(result.value).toEqual([
        "invalid_argument",
        true,
        expect.stringContaining("move next"),
      ]);
      expect(
        sent.filter((entry) => entry.tool === "click").map((entry) => entry.args),
      ).toMatchObject([
        { action: "name:move next\ntarget:0x0\nselector:(null)" },
        { action: "press" },
      ]);
    });
  },
);

it("held keys forward duration only at or above the minimum driver version", () => {
  const bound: BoundWindow = {
    ref: {
      id: "target",
      kind: "app",
      environmentId: "env",
      runId: "r",
      turnId: "t",
      generation: 0,
    },
    pid: 42,
    windowId: 7,
    appId: "org.example.Editor",
    controlId: "control",
    epoch: 0,
    connectionGeneration: "driver:1",
  };
  const plan = (version: string) =>
    prepareDesktopInput("press_key", { key: "a", holdMs: 123 }, bound, () => undefined, undefined, {
      version,
      minimumVersion: "0.38.0-goat.16",
    });
  expect(plan("0.38.0-goat.15")).toMatchObject({
    error: { code: "unsupported", effectStarted: false },
  });
  expect(plan("0.38.0-goat.9")).toMatchObject({
    error: { code: "unsupported", effectStarted: false },
  });
  for (const version of ["0.38.0-goat.16", "0.38.0-goat.17", "0.38.0-goat.20", "0.38.0-goat.100"]) {
    const result = plan(version);
    expect(result.forwarded).toMatchObject({ key: "a", duration_ms: 123 });
    expect(result.forwarded).not.toHaveProperty("holdMs");
  }
  expect(plan("not-a-version")).toMatchObject({
    error: { code: "unsupported", effectStarted: false },
  });
});

it.live(
  "advertised actions resolve exact names, builtin aliases and ambiguous displayed names",
  () => {
    const first = "Name:Move Next\nTarget:one\nSelector:first";
    const second = "Name:Move Next\nTarget:two\nSelector:second";
    const alias = "Name:press\nTarget:one\nSelector:custom";
    const specialState = {
      ...state,
      tree_markdown: '- [1] AXButton "Apply" [actions=[press,move next]]',
      elements: [{ ...state.elements[0], actions: ["AXPress", first, second, alias] }],
    };
    const { host, sent } = fixture({ get_window_state: specialState });
    return Effect.gen(function* () {
      const result = yield* run(
        `const raw = ${JSON.stringify(first)};
      await app.click(1, {action:raw});
      await app.click(1, {action:'press'});
      try { await app.click(1, {action:'move next'}); } catch(e) { return [e.code, e.nothingSent, e.nextStep]; }`,
        host,
      );
      expect(result.value).toEqual([
        "invalid_argument",
        true,
        expect.stringContaining("Move Next"),
      ]);
      expect(result.value).toEqual([
        "invalid_argument",
        true,
        expect.stringContaining("Target:one"),
      ]);
      expect(result.value).toEqual([
        "invalid_argument",
        true,
        expect.stringContaining("Target:two"),
      ]);
      expect(
        sent.filter((entry) => entry.tool === "click").map((entry) => entry.args),
      ).toMatchObject([{ action: first }, { action: "press" }]);
    });
  },
);

it.live("a displayed lowercase custom name resolves to the full mixed-case raw action", () => {
  const raw = "Name:Move Next\nTarget:one\nSelector:first";
  const specialState = { ...state, elements: [{ ...state.elements[0], actions: [raw] }] };
  const { host, sent } = fixture({ get_window_state: specialState });
  return Effect.gen(function* () {
    const result = yield* run("return (await app.click(1, {action:'move next'})).verdict;", host);
    expect(result.value).toBe("confirmed");
    expect(sent.filter((entry) => entry.tool === "click").map((entry) => entry.args)).toMatchObject(
      [{ action: raw }],
    );
  });
});

it.live("an advertised AXPress requested by its raw name forwards the driver press action", () => {
  const { host, sent } = fixture({ get_window_state: state });
  return Effect.gen(function* () {
    const result = yield* run(
      "return (await app.click(1, {action:'AXPress', count:2})).verdict;",
      host,
    );
    expect(result.value).toBe("confirmed");
    expect(sent.filter((entry) => entry.tool === "click").map((entry) => entry.args)).toMatchObject(
      [{ action: "press", count: 2 }],
    );
  });
});

it.live(
  "app press sends background by default and an explicit foreground once, and refuses any other delivery mode unsent",
  () => {
    const { host, sent } = fixture({ get_window_state: state });
    return Effect.gen(function* () {
      const result = yield* run(
        `await app.press('Enter', 1); await app.press('Enter', 1, {delivery_mode: 'background'});
      await app.press('cmd+s', {delivery_mode: 'foreground'});
      const refused = [];
      for (const options of [{delivery_mode: 'Foreground'}, {delivery_mode: 'foreground '}, {delivery_mode: 'hid'},
        {delivery_mode: null}, {delivery_mode: 1}, {send: true, delivery_mode: 'foreground'}]) {
        try { await app.press('Enter', 1, options); refused.push('sent'); }
        catch(e) { refused.push([e.code, e.nothingSent, e.message]); }
      } return refused;`,
        host,
      );
      const invalid = 'delivery_mode is "background" or "foreground"; nothing was sent.';
      expect(result.value).toEqual([
        ...Array.from({ length: 5 }, () => ["invalid_argument", true, invalid]),
        [
          "invalid_argument",
          true,
          'delivery_mode "foreground" cannot be combined with send; nothing was sent.',
        ],
      ]);
      const presses = sent
        .filter((entry) => entry.tool === "press_key")
        .map((entry) => entry.args as Record<string, unknown>);
      expect(presses.map((args) => args.delivery_mode)).toEqual([
        "background",
        "background",
        "foreground",
      ]);
      expect(presses[2]).toMatchObject({ target: { kind: "window", pid: 42, window_id: 7 } });
      expect(sent.filter((entry) => entry.tool === "get_window_state")).toHaveLength(1);
    });
  },
);

it.live(
  "a background press the driver refuses for an unreadable menu stays refused and is not retried in the foreground",
  () => {
    const unreadable =
      "press_key: the app's menu could not be fully read. Retry, or use invoke_menu. No key or menu action was sent.";
    const { host, sent } = fixture({
      get_window_state: state,
      press_key: new DriverError(
        {
          code: "background_unavailable",
          effect: "refused",
          dispatched: false,
          message: unreadable,
        },
        unreadable,
      ),
    });
    return Effect.gen(function* () {
      const result = yield* run(
        "try { await app.press('cmd+s', 1); return 'sent'; } catch(e) { return [e.code, e.nothingSent, e.message, e.refused]; }",
        host,
      );
      expect(result.value).toEqual(["unsupported", true, unreadable, "backgroundUnavailable"]);
      expect(
        sent.filter((entry) => entry.tool === "press_key").map((entry) => entry.args),
      ).toMatchObject([{ delivery_mode: "background" }]);
    });
  },
);

it("only press_key forwards an explicit foreground delivery; anything else stays background", () => {
  const bound: BoundWindow = {
    ref: {
      id: "target",
      kind: "app",
      environmentId: "env",
      runId: "r",
      turnId: "t",
      generation: 0,
    },
    pid: 42,
    windowId: 7,
    appId: "org.example.Editor",
    controlId: "control",
    epoch: 0,
    connectionGeneration: "driver:1",
  };
  const forwarded = (method: string, args: Record<string, unknown>) =>
    prepareDesktopInput(method, args, bound, () => undefined, undefined, {
      version: "0.38.0-goat.16",
      minimumVersion: "0.38.0-goat.16",
    }).forwarded;
  expect(forwarded("press_key", { key: "a", delivery_mode: "foreground" })).toMatchObject({
    delivery_mode: "foreground",
  });
  expect(
    forwarded("press_key", { key: "a", holdMs: 50, delivery_mode: "foreground" }),
  ).toMatchObject({ duration_ms: 50, delivery_mode: "foreground" });
  for (const [method, args] of [
    ["press_key", { key: "a" }],
    ["press_key", { key: "a", delivery_mode: "bogus" }],
    ["press_key", { key: "a", send: true, delivery_mode: "foreground" }],
    ["click", { x: 1, y: 1, delivery_mode: "foreground" }],
  ] as const)
    expect(forwarded(method, args)).toMatchObject({ delivery_mode: "background" });
});
