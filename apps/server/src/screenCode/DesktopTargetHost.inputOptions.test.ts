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
import { context, fixture } from "./DesktopTargetHost.testkit.ts";

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
        { action: "AXPress" },
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
      ).toMatchObject([{ action: first }, { action: "AXPress" }]);
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
