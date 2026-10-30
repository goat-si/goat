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

it.effect.each(["linux", "win32", "darwin"] as const)(
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
  "a window list cut at the cap refuses every bind but one through the app's only process",
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
      ).toEqual([{ pid: 900 }]);
      // Neither can show whose window it is or that no other window has its id.
      for (const args of [{ window_id: 4194307 }, { name: "python3", window_id: 4194307 }]) {
        const refused = yield* bindResult(host, args);
        expect(refused._tag === "Failure" && refused.failure.code).toBe("downstream_failure");
      }
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
      ).toEqual([{ app: "thunar" }, { pid: 900 }]);
    }),
);

it.effect("a window another app's filter leaves out is named with its owner, not as closed", () =>
  Effect.gen(function* () {
    const { host } = fixture(
      { list_apps: cut, list_windows: listWindows([script, thunarWindow]) },
      undefined,
      undefined,
      undefined,
      "linux",
    );
    const result = yield* bindResult(host, { bundle_id: "thunar", window_id: 4194307 });
    expect(result._tag === "Failure" && result.failure.code).toBe("target_missing");
    expect(result._tag === "Failure" && result.failure.nextStep).toContain(
      "Scratch-cu-window.py (pid 1555)",
    );
  }),
);

it.effect("a bind whose process window list comes back cut is refused", () =>
  Effect.gen(function* () {
    const { host } = fixture(
      {
        list_apps: { apps: appRows },
        list_windows: (args: { pid?: number }) =>
          args.pid === undefined ? listWindows([script, thunarWindow])(args) : cut,
      },
      undefined,
      undefined,
      undefined,
      "linux",
    );
    const result = yield* bindResult(host, { window_id: 4194307 });
    expect(result._tag === "Failure" && result.failure.code).toBe("downstream_failure");
  }),
);

it.effect("a window of a process two apps share binds only under the app whose row holds it", () =>
  Effect.gen(function* () {
    // One soffice.bin shows Calc and Writer; list_apps puts each window in its own app's row.
    const calc = { ...script, pid: 3000, window_id: 5001, app_name: "libreoffice-calc" };
    const writer = { ...script, pid: 3000, window_id: 5002, app_name: "libreoffice-writer" };
    const { host } = fixture(
      {
        list_apps: {
          apps: [
            {
              pid: 3000,
              name: "Calc",
              bundle_id: "libreoffice-calc",
              running: true,
              windows: [calc],
            },
            {
              pid: 3000,
              name: "Writer",
              bundle_id: "libreoffice-writer",
              running: true,
              windows: [writer],
            },
          ],
        },
        list_windows: listWindows([calc, writer]),
      },
      undefined,
      undefined,
      undefined,
      "linux",
    );
    const wrong = yield* bindResult(host, { bundle_id: "libreoffice-calc", window_id: 5002 });
    expect(wrong._tag === "Failure" && wrong.failure.code).toBe("target_missing");
    expect(wrong._tag === "Failure" && wrong.failure.nextStep).toContain(
      "libreoffice-writer (pid 3000)",
    );
    const right = yield* bindResult(host, { bundle_id: "libreoffice-calc", window_id: 5001 });
    expect(right._tag).toBe("Success");
  }),
);

it.effect(
  "an installed copy at pid 0 leaves the app's one running process to list its own windows",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_apps: {
          apps: [
            { pid: 0, name: "Editor", bundle_id: "org.example.Editor", running: false },
            { pid: 42, name: "Editor", bundle_id: "org.example.Editor", running: true },
          ],
        },
        list_windows: (args: { pid?: number }) =>
          args.pid === 42 ? { windows: [{ pid: 42, window_id: 7, layer: 3 }] } : { windows: [] },
      });
      const bound = yield* bindResult(host, { bundle_id: "org.example.Editor", window_id: 7 });
      expect(bound._tag).toBe("Success");
      expect(
        sent.filter((entry) => entry.tool === "list_windows").map((entry) => entry.args),
      ).toEqual([{ pid: 42 }]);
    }),
);

it.effect("on macOS a window missing from the layer-0 list is not called closed", () =>
  Effect.gen(function* () {
    const { host } = fixture({ list_apps: { apps: [] }, list_windows: { windows: [] } });
    const result = yield* bindResult(host, { window_id: 77 });
    expect(result._tag === "Failure" && result.failure.code).toBe("target_missing");
    expect(result._tag === "Failure" && result.failure.nextStep).toContain(
      "a panel macOS lists only with its app",
    );
  }),
);

it.effect.each([
  { case: "closed", baseline: [], code: "target_missing" },
  { case: "listed twice", baseline: [script, script], code: "target_ambiguous" },
])("a window the process's own list then shows $case is not bound", ({ baseline, code }) =>
  Effect.gen(function* () {
    const { host } = fixture(
      {
        list_apps: { apps: appRows },
        list_windows: (args: { pid?: number }) =>
          args.pid === undefined ? { windows: [script, thunarWindow] } : { windows: baseline },
      },
      undefined,
      undefined,
      undefined,
      "linux",
    );
    const result = yield* bindResult(host, { window_id: 4194307 });
    expect(result._tag === "Failure" && result.failure.code).toBe(code);
  }),
);

it.effect("macOS's bundle filter binds a window whose name does not contain the bundle id", () =>
  Effect.gen(function* () {
    const editor = { pid: 42, window_id: 7, app_name: "Editor", layer: 0 };
    const { host } = fixture({
      list_apps: cut,
      // The driver passes the window's bundle id to its filter, but lists no bundle_id field.
      list_windows: (args: { app?: string; pid?: number }) =>
        args.app === "com.example.Editor" || args.pid === 42
          ? { windows: [editor] }
          : { windows: [] },
      get_window_state: { ...state, pid: 42, window_id: 7 },
    });
    const bound = yield* bindResult(host, { bundle_id: "com.example.Editor", window_id: 7 });
    expect(bound._tag).toBe("Success");
  }),
);

it.effect("a window missing from a list that may be incomplete is not called closed", () =>
  Effect.gen(function* () {
    const partial = { windows: [thunarWindow], enumeration_complete: false };
    const held = { windows: [thunarWindow], authoritative_window_ids: [4194311, 4194307] };
    for (const reply of [partial, held]) {
      const { host } = fixture(
        { list_apps: { apps: appRows }, list_windows: reply },
        undefined,
        undefined,
        undefined,
        "linux",
      );
      const result = yield* bindResult(host, { window_id: 4194307 });
      expect(result._tag === "Failure" && result.failure.code).toBe("downstream_failure");
    }
  }),
);

it.live("a name's window list that may be incomplete launches and binds nothing", () => {
  const { host, sent } = fixture(
    {
      list_apps: { apps: appRows },
      list_windows: { windows: [script], enumeration_complete: false },
      launch_app: { pid: 1 },
    },
    undefined,
    undefined,
    undefined,
    "linux",
  );
  return Effect.gen(function* () {
    const result = yield* cell(host, caught("await screen.app('Scratch-cu-window.py');"));
    expect(result.value).toMatchObject({ code: "target_missing" });
    expect(tools(sent)).not.toContain("launch_app");
    expect(tools(sent)).not.toContain("bind_app");
  });
});
