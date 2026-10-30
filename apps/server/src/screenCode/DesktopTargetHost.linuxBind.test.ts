import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, fixture, state } from "./DesktopTargetHost.testkit.ts";

// Shapes cua-driver-rs 0.38.0-goat.14 lists on X11 (goat-si/goat#2248): a Tk script's window
// carries its WM_CLASS as app_name, while list_apps has only /proc rows for the interpreter,
// one of several python3 processes, beside an installed app with a desktop file id.
const script = {
  pid: 1555,
  window_id: 4194307,
  title: "GOAT box CU test",
  app_name: "Scratch-cu-window.py",
  bounds: { x: 0, y: 0, width: 320, height: 200 },
  is_on_screen: true,
  z_index: 2,
};
const thunarWindow = { ...script, pid: 900, window_id: 4194311, title: "Home", app_name: "Thunar" };
const appRows = [
  { pid: 700, name: "python3", bundle_id: null, running: true, windows: [] },
  { pid: 1555, name: "python3", bundle_id: null, running: true, windows: [script] },
  { pid: 900, name: "Thunar", bundle_id: "thunar", running: true, windows: [thunarWindow] },
];
const listWindows =
  (all: ReadonlyArray<typeof script>) => (args: { pid?: number; app?: string }) => ({
    windows: all.filter(
      (window) =>
        (args.pid === undefined || window.pid === args.pid) &&
        (args.app === undefined || window.app_name.toLowerCase().includes(args.app.toLowerCase())),
    ),
  });
const linux = (windows: ReadonlyArray<typeof script> = [script, thunarWindow]) =>
  fixture(
    {
      list_apps: { apps: appRows },
      list_windows: listWindows(windows),
      get_window_state: { ...state, pid: 1555, window_id: 4194307 },
    },
    undefined,
    undefined,
    undefined,
    "linux",
  );

const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
const cell = (host: ReturnType<typeof fixture>["host"], source: string) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({ ...turn, invocation: context.invocation, source });
    yield* service.finishTurn({ ...turn, reason: "test" });
    return result;
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
const caught = (code: string) =>
  `try { ${code} } catch (error) { return { code: error.code, message: error.message }; }`;
const tools = (sent: ReturnType<typeof fixture>["sent"]) => sent.map((entry) => entry.tool);

it.live.each([
  { how: "its window_id alone", query: "{window_id: 4194307}" },
  {
    how: "the app_name screen.discover() lists with window_id",
    query: "{name: 'Scratch-cu-window.py', window_id: 4194307}",
  },
  { how: "its process name with window_id", query: "{name: 'python3', window_id: 4194307}" },
  { how: "the app_name screen.discover() lists, alone", query: "'Scratch-cu-window.py'" },
])("a script window with no desktop entry binds by $how", ({ query }) => {
  const { host, sent } = linux();
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      `const app = await screen.app(${query}); const seen = await app.observe(); ` +
        "return {windowId: app.windowId, launched: app.launched, read: seen.elements.length > 0};",
    );
    expect(result.value).toEqual({ windowId: 4194307, launched: false, read: true });
    expect(sent.find((entry) => entry.tool === "get_window_state")?.args).toMatchObject({
      pid: 1555,
      window_id: 4194307,
    });
    expect(tools(sent)).not.toContain("launch_app");
  });
});

it.live("a name the window does not carry is refused, naming whose window it is", () => {
  const { host, sent } = linux();
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      caught("await screen.app({name: 'Thunar', window_id: 4194307});"),
    );
    expect(result.value).toMatchObject({ code: "target_missing" });
    expect((result.value as { message: string }).message).toContain(
      "Scratch-cu-window.py (pid 1555)",
    );
    expect(tools(sent)).not.toContain("get_window_state");
  });
});

it.live("two windows under one discovered app_name are ambiguous and name both ids", () => {
  const second = { ...script, pid: 1600, window_id: 4194400, title: "Second" };
  const { host, sent } = linux([script, second, thunarWindow]);
  return Effect.gen(function* () {
    const result = yield* cell(host, caught("await screen.app('Scratch-cu-window.py');"));
    expect(result.value).toMatchObject({ code: "target_ambiguous" });
    const message = (result.value as { message: string }).message;
    expect(message).toContain("4194307");
    expect(message).toContain("4194400");
    expect(tools(sent)).not.toContain("bind_app");
    expect(tools(sent)).not.toContain("launch_app");
  });
});

it.live("a window_id no window has is refused as gone", () => {
  const { host } = linux();
  return Effect.gen(function* () {
    const result = yield* cell(host, caught("await screen.app({window_id: 99});"));
    expect(result.value).toMatchObject({ code: "target_missing" });
  });
});
