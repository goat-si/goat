import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { call, context, fixture, state } from "./DesktopTargetHost.testkit.ts";

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
    const bind = result.journal.find((entry) => entry.receipt.method === "bind_app");
    expect(bind?.receipt.safety?.code).toBe("read_completed");
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

it.live(
  "discovery that returned its lists is a completed read; a cut list stays indeterminate",
  () => {
    const whole = linux();
    const cut = fixture({
      list_apps: { message: "Driver reply exceeded the primitive channel limit." },
    });
    return Effect.gen(function* () {
      const listed = yield* cell(whole.host, "await screen.discover(); return 1;");
      const codes = (result: typeof listed) =>
        Object.fromEntries(
          result.journal
            .filter((entry) => entry.receipt.method.startsWith("list_"))
            .map((entry) => [entry.receipt.method, entry.receipt.safety?.code]),
        );
      expect(codes(listed)).toMatchObject({
        list_apps: "read_completed",
        list_windows: "read_completed",
      });
      const partial = yield* cell(cut.host, "await screen.discover(); return 1;");
      expect(codes(partial)).toMatchObject({
        list_apps: "read_indeterminate",
        list_windows: "read_completed",
      });
    });
  },
);

const cut = { message: "Driver reply exceeded the primitive channel limit." };
const bindCall = (args: Record<string, string | number>) => call("bind_app", args);
const bindResult = (
  host: ReturnType<typeof fixture>["host"],
  args: Record<string, string | number>,
) => host.bindApp(bindCall(args), context).pipe(Effect.result);

it.live("a name no app row carries launches nothing when the window list comes back cut", () => {
  const { host, sent } = fixture(
    { list_apps: { apps: appRows }, list_windows: cut, launch_app: { pid: 1 } },
    undefined,
    undefined,
    undefined,
    "linux",
  );
  return Effect.gen(function* () {
    const result = yield* cell(host, caught("await screen.app('Scratch-cu-window.py');"));
    expect(result.value).toMatchObject({ code: "target_missing" });
    expect(tools(sent)).not.toContain("launch_app");
  });
});

it.effect.each(["linux", "win32"] as const)(
  "a cut app list on %s binds a window only by its own app_name or its id",
  (platform) =>
    Effect.gen(function* () {
      // Linux's and Windows' app filters match a substring: "code" also finds "Xcode-helper".
      const helper = { ...script, pid: 2000, window_id: 4194500, app_name: "Xcode-helper" };
      const { host } = fixture(
        {
          list_apps: cut,
          list_windows: listWindows([script, thunarWindow, helper]),
          get_window_state: { ...state, pid: 1555, window_id: 4194307 },
        },
        undefined,
        undefined,
        undefined,
        platform,
      );
      const substring = yield* bindResult(host, { bundle_id: "code", window_id: 4194500 });
      expect(substring._tag === "Failure" && substring.failure.code).toBe("target_missing");
      const thunar = yield* bindResult(host, { bundle_id: "thunar", window_id: 4194311 });
      expect(thunar._tag).toBe("Success");
      const byProcess = yield* bindResult(host, { name: "python3", window_id: 4194307 });
      expect(byProcess._tag === "Failure" && byProcess.failure.nextStep).toContain(
        "app list came back incomplete",
      );
      for (const args of [
        { name: "Scratch-cu-window.py", window_id: 4194307 },
        { window_id: 4194307 },
      ])
        expect((yield* bindResult(host, args))._tag).toBe("Success");
    }),
);

it.effect("a window id listed for two processes is ambiguous even when one matches the name", () =>
  Effect.gen(function* () {
    const { host } = fixture(
      {
        list_apps: { apps: appRows },
        list_windows: listWindows([script, { ...script, pid: 900, app_name: "Thunar" }]),
      },
      undefined,
      undefined,
      undefined,
      "linux",
    );
    const result = yield* bindResult(host, { name: "python3", window_id: 4194307 });
    expect(result._tag === "Failure" && result.failure.code).toBe("target_ambiguous");
  }),
);

it.effect(
  "a window list cut at the cap is read again per process, and window_id alone is refused",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture(
        {
          list_apps: { apps: appRows },
          list_windows: (args: { pid?: number }) =>
            args.pid === undefined ? cut : listWindows([script, thunarWindow])(args),
        },
        undefined,
        undefined,
        undefined,
        "linux",
      );
      const thunar = yield* bindResult(host, { bundle_id: "thunar", window_id: 4194311 });
      expect(thunar._tag).toBe("Success");
      expect(
        sent.filter((entry) => entry.tool === "list_windows").map((entry) => entry.args),
      ).toEqual([{}, { pid: 900 }]);
      const alone = yield* bindResult(host, { window_id: 4194307 });
      expect(alone._tag === "Failure" && alone.failure.code).toBe("downstream_failure");
    }),
);

it.effect(
  "a window found through another app's filter reads its process's windows as the baseline",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture(
        {
          list_apps: cut,
          list_windows: (args: { pid?: number; app?: string }) =>
            args.pid === undefined && args.app === undefined
              ? cut
              : listWindows([
                  thunarWindow,
                  { ...thunarWindow, window_id: 4194312, app_name: "Thunar-bulk" },
                ])(args),
        },
        undefined,
        undefined,
        undefined,
        "linux",
      );
      const thunar = yield* bindResult(host, { bundle_id: "thunar", window_id: 4194311 });
      expect(thunar._tag).toBe("Success");
      expect(
        sent.filter((entry) => entry.tool === "list_windows").map((entry) => entry.args),
      ).toEqual([{}, { app: "thunar" }, { pid: 900 }]);
    }),
);
