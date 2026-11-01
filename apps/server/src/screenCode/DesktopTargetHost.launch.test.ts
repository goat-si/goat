import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import {
  type ComputerUsePrimitiveReply,
  type ScreenHostCall,
  type ScreenRunLimits,
  type ScreenTargetRef,
  SCREEN_TARGET_API,
} from "@goat/contracts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { launchPlan } from "./DesktopLaunch.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import {
  NotStarted,
  UnknownOutcome,
  call as bindCallOf,
  context,
  fixture,
} from "./DesktopTargetHost.testkit.ts";

const bindCall = (args: Record<string, string | number>) => bindCallOf("bind_app", args);

const installed = {
  pid: 0,
  running: false,
  name: "Editor",
  bundle_id: "org.example.Editor",
  launch_path: "/Applications/Editor.app",
};
const running = { ...installed, pid: 42, running: true };
const document = {
  pid: 42,
  window_id: 7,
  title: "Document",
  layer: 0,
  is_on_screen: true,
  bounds: { x: 0, y: 0, width: 400, height: 300 },
};
const launched = (windows: readonly object[]) => ({
  pid: 42,
  bundle_id: "org.example.Editor",
  name: "Editor",
  windows,
  launch_state: { request_sent: true, process_running: true, window_ready: windows.length > 0 },
});
// Shapes cua-driver 0.38.0-goat.9 listed for Activity Monitor after its window was closed.
const closedKept = { ...document, is_on_screen: false, on_current_space: true, space_ids: [3] };
const bar = {
  pid: 42,
  window_id: 9,
  title: "",
  layer: 0,
  is_on_screen: false,
  space_ids: null,
  bounds: { x: 0, y: 0, width: 3840, height: 30 },
};
const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };

/** Runs one cell through the real guest runtime against the fixture host. */
const cell = (
  host: ReturnType<typeof fixture>["host"],
  source: string,
  limits?: Partial<ScreenRunLimits>,
) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      ...turn,
      invocation: context.invocation,
      source,
      ...(limits === undefined ? {} : { limits }),
    });
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
const tools = (sent: ReturnType<typeof fixture>["sent"]) => sent.map((entry) => entry.tool);
const caught = (code: string) =>
  `try { ${code} } catch (error) { return { code: error.code, nothingSent: error.nothingSent, message: error.message }; }`;

it.live("a closed app launches and binds its first window in one screen.app call", () => {
  const { host, sent } = fixture({
    list_apps: { apps: [installed] },
    launch_app: launched([document]),
  });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      "const app = await screen.app({bundle_id: 'org.example.Editor'}); const seen = await app.observe(); " +
        "return {launched: app.launched, windowId: app.windowId, kind: app.kind, read: seen.text.includes('Apply')};",
    );
    expect(result.value).toEqual({ launched: true, windowId: 7, kind: "app", read: true });
    expect(tools(sent).slice(0, 2)).toEqual(["list_apps", "launch_app"]);
    expect(sent[1]?.args).toEqual({ bundle_id: "org.example.Editor" });
    // The launch is the cell's input: a launch_app write receipt, not a read.
    expect(result.journal.map((entry) => entry.receipt.method)).toContain("launch_app");
  });
});

it.live("a running app with no window yet is not launched again", () => {
  const { host, sent } = fixture({
    list_apps: { apps: [running] },
    list_windows: { windows: [] },
    launch_app: launched([document]),
  });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      caught("await screen.app({bundle_id: 'org.example.Editor'});"),
    );
    expect(result.value).toMatchObject({ code: "target_missing", nothingSent: true });
    expect((result.value as { message: string }).message).toContain("pid 42");
    expect(tools(sent)).toEqual(["list_apps", "list_windows"]);
  });
});

it.live("a running app's only window binds without a launch, past its menu bar item", () => {
  // An older driver's list_apps has no running field; list_windows with a pid lists every layer.
  const { host, sent } = fixture({
    list_windows: { windows: [document, { pid: 42, window_id: 9, layer: 25 }] },
  });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      "const app = await screen.app({bundleId: 'org.example.Editor'}); return {launched: app.launched, windowId: app.windowId};",
    );
    expect(result.value).toEqual({ launched: false, windowId: 7 });
    expect(tools(sent)).not.toContain("launch_app");
  });
});

it.live("a bundle id passed as a string binds the running app's window without a launch", () => {
  const { host, sent } = fixture({
    list_apps: { apps: [running] },
    list_windows: { windows: [document] },
    launch_app: launched([document]),
  });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      "const app = await screen.app('org.example.Editor'); return {launched: app.launched, windowId: app.windowId};",
    );
    expect(result.value).toEqual({ launched: false, windowId: 7 });
    expect(tools(sent)).not.toContain("launch_app");
    expect(result.journal.map((entry) => entry.receipt.method)).not.toContain("launch_app");
  });
});

it.live("a running app listed without its id is named, never bound or relaunched by name", () => {
  const { host, sent } = fixture({
    list_apps: {
      apps: [
        { pid: 0, running: false, name: "Editor", bundle_id: "org.example.Editor.desktop" },
        { pid: 42, running: true, name: "Editor", bundle_id: null },
      ],
    },
  });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      caught("await screen.app({bundle_id: 'org.example.Editor.desktop'});"),
    );
    expect(result.value).toMatchObject({ code: "target_ambiguous", nothingSent: true });
    expect(tools(sent)).toEqual(["list_apps"]);
    // The recovery the error names binds that process's window.
    const followed = yield* cell(
      host,
      "const app = await screen.app({name: 'Editor', window_id: 7}); return {launched: app.launched, windowId: app.windowId};",
    );
    expect(followed.value).toEqual({ launched: false, windowId: 7 });
    expect(tools(sent)).not.toContain("launch_app");
  });
});

it.live("a name an identified app shares with a process listed without an id is ambiguous", () => {
  const { host, sent } = fixture({
    list_apps: { apps: [running, { pid: 50, running: true, name: "Editor", bundle_id: null }] },
  });
  return Effect.gen(function* () {
    const result = yield* cell(host, caught("await screen.app({name: 'Editor'});"));
    expect(result.value).toMatchObject({ code: "target_ambiguous", nothingSent: true });
    expect(tools(sent)).toEqual(["list_apps"]);
  });
});

it.live("an app or window list cut at the channel cap launches nothing", () => {
  // Linux list_apps on a real desktop passes the 64 KiB cap and arrives as this placeholder.
  const cut = { message: "Driver reply exceeded the primitive channel limit." };
  const apps = fixture({ list_apps: cut, launch_app: launched([document]) });
  const windows = fixture({
    list_apps: { apps: [running] },
    list_windows: cut,
    launch_app: launched([document]),
  });
  return Effect.gen(function* () {
    for (const { host, sent } of [apps, windows]) {
      const result = yield* cell(
        host,
        caught("await screen.app({bundle_id: 'org.example.Editor'});"),
      );
      expect(result.value).toMatchObject({ code: "target_missing", nothingSent: true });
      expect(tools(sent)).not.toContain("launch_app");
    }
  });
});

it.effect("App.launch() relaunches by the queried bundle id after a cut app list", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_apps: { message: "Driver reply exceeded the primitive channel limit." },
      list_windows: { windows: [{ ...document, app_name: "org.example.Editor" }] },
    });
    const bound = yield* host.bindApp(
      bindCall({ bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    yield* host.invoke(
      { ...bindCall({}), method: "launch_app", targetRef: bound.value as ScreenTargetRef },
      context,
    );
    expect(sent.at(-1)).toMatchObject({
      tool: "launch_app",
      args: { bundle_id: "org.example.Editor" },
    });
  }),
);

it.live("a running app with several windows is ambiguous and nothing launches", () => {
  const { host, sent } = fixture({
    list_apps: { apps: [running] },
    list_windows: { windows: [document, { ...document, window_id: 8, title: "Other" }] },
  });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      caught("await screen.app({bundle_id: 'org.example.Editor'});"),
    );
    expect(result.value).toMatchObject({ code: "target_ambiguous", nothingSent: true });
    expect(tools(sent)).not.toContain("launch_app");
  });
});

it.live("a running app whose windows are all off screen is named, not relaunched", () => {
  // A window the app closed but keeps lists like a minimized one: off screen, on a Space.
  const { host, sent } = fixture({
    list_apps: { apps: [running] },
    list_windows: { windows: [closedKept] },
  });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      caught("await screen.app({bundle_id: 'org.example.Editor'});"),
    );
    expect(result.value).toMatchObject({ code: "target_missing", nothingSent: true });
    expect(String((result.value as { message: string }).message)).toContain("7");
    expect(tools(sent)).not.toContain("launch_app");
  });
});

it.live(
  "several installed copies launch the /Applications one, or the bundle id under an app list",
  () => {
    const { host, sent } = fixture({
      list_apps: {
        apps: [{ ...installed, launch_path: "/Users/me/DerivedData/Editor.app" }, installed],
      },
      launch_app: (args: { name?: string }) =>
        args.name === undefined
          ? launched([document])
          : new NotStarted({ refused: "appNotAllowed", detail: "app_not_approved" }),
    });
    return Effect.gen(function* () {
      const result = yield* cell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor'}); return app.windowId;",
      );
      expect(result.value).toBe(7);
      expect(
        sent.filter((entry) => entry.tool === "launch_app").map((entry) => entry.args),
      ).toEqual([{ name: "/Applications/Editor.app" }, { bundle_id: "org.example.Editor" }]);
    });
  },
);

it.live("a path list_apps does not list is refused before anything launches", () => {
  const { host, sent } = fixture({ list_apps: { apps: [running] } });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      caught("await screen.app({path: '/Users/me/Old/Editor.app'});"),
    );
    expect(result.value).toMatchObject({ code: "invalid_argument", nothingSent: true });
    expect(tools(sent)).toEqual(["list_apps"]);
  });
});

it.live("a name resolves to its one bundle id, and a name two apps share is ambiguous", () => {
  const copies = fixture({
    list_apps: {
      apps: [{ ...installed, launch_path: "/Users/me/DerivedData/Editor.app" }, installed],
    },
    launch_app: launched([document]),
  });
  const shared = fixture({
    list_apps: { apps: [installed, { ...installed, bundle_id: "com.other.Editor" }] },
  });
  return Effect.gen(function* () {
    const bound = yield* cell(
      copies.host,
      "const app = await screen.app({name: 'Editor'}); return app.launched;",
    );
    expect(bound.value).toBe(true);
    expect(copies.sent.find((entry) => entry.tool === "launch_app")?.args).toEqual({
      name: "/Applications/Editor.app",
    });
    const refused = yield* cell(shared.host, caught("await screen.app({name: 'Editor'});"));
    expect(refused.value).toMatchObject({ code: "target_ambiguous", nothingSent: true });
    expect(tools(shared.sent)).toEqual(["list_apps"]);
  });
});

it.live("a listed path with a window_id binds that window of the app it names", () => {
  const { host, sent } = fixture({ list_apps: { apps: [running] } });
  return Effect.gen(function* () {
    const result = yield* cell(
      host,
      "const app = await screen.app({path: '/Applications/Editor.app', window_id: 7}); return {launched: app.launched, windowId: app.windowId};",
    );
    expect(result.value).toEqual({ launched: false, windowId: 7 });
    expect(tools(sent)).not.toContain("launch_app");
  });
});

it.live("a launch the cell cannot wait out stops the cell's later input", () => {
  const other = { pid: 50, running: true, name: "Other", bundle_id: "org.example.Other" };
  const { host, sent } = fixture({
    list_apps: { apps: [installed, other] },
    list_windows: (args: { pid?: number }) => ({
      windows:
        args.pid === undefined || args.pid === 50 ? [{ pid: 50, window_id: 11, layer: 0 }] : [],
    }),
    launch_app: launched([]),
  });
  return Effect.gen(function* () {
    // A 3 s cell leaves no room for a whole list_windows cap, so the wait ends at once.
    const result = yield* cell(
      host,
      "const other = await screen.app({bundle_id: 'org.example.Other', window_id: 11}); " +
        "let launch; try { await screen.app({bundle_id: 'org.example.Editor'}); } catch (error) { launch = {code: error.code, nothingSent: error.nothingSent, message: error.message}; } " +
        "let click; try { await other.click({x: 1, y: 2}); } catch (error) { click = error.code; } " +
        "let again; try { await screen.launch({bundle_id: 'org.example.Other'}); } catch (error) { again = error.code; } " +
        "return {launch, click, again};",
      { cellWallMs: 3_000 },
    );
    expect(result.value).toMatchObject({
      launch: { code: "target_missing", nothingSent: false },
      click: "not_run",
      again: "not_run",
    });
    expect(String((result.value as { launch: { message: string } }).launch.message)).toContain(
      "no time left",
    );
    expect(tools(sent).filter((tool) => tool === "launch_app")).toHaveLength(1);
    expect(tools(sent)).not.toContain("click");
  });
});

const launchCall = (args: Record<string, unknown>): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId: 1,
  method: "launch_app",
  args: [{ bundle_id: "org.example.Editor", bind: true, ...args }],
  deadlineMillis: 60_000,
});

it.effect.each(["stopped_by_person", "screen_locked"] as const)(
  "a %s during launch verification preserves the terminal guidance",
  (code) =>
    Effect.gen(function* () {
      const { host } = fixture({
        launch_app: launched([]),
        list_windows: new UnknownOutcome({ code }, "The person stopped computer use."),
      });
      const pending = yield* host
        .invoke(launchCall({}), context)
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(pending);
      expect(error.code).toBe(code);
      expect(error.safety?.possibleCommit).toBe(true);
      expect(error.safety?.retryClass).toBe("never");
      expect(error.nextStep).not.toContain("screen.discover()");
    }),
);

it.effect("a launch waits for the first window on the driver that launched it", () =>
  Effect.gen(function* () {
    let polls = 0;
    const { host, sent } = fixture({
      launch_app: launched([]),
      list_windows: () => ({ windows: ++polls < 3 ? [] : [document] }),
    });
    const fiber = yield* host.invoke(launchCall({}), context).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const bound = yield* Fiber.join(fiber);
    expect(bound.value).toMatchObject({ launched: true, windowId: 7, pid: 42 });
    const listed = sent.filter((entry) => entry.tool === "list_windows");
    expect(listed).toHaveLength(3);
    expect(listed.every((entry) => entry.expectedConnectionGeneration === "driver:1")).toBe(true);
  }),
);

it.effect(
  "a launched app that shows no window on screen fails after the wait with the launch's write safety",
  () =>
    Effect.gen(function* () {
      const { host } = fixture({
        launch_app: launched([closedKept, bar]),
        list_windows: { windows: [closedKept, bar] },
      });
      const fiber = yield* host.invoke(launchCall({}), context).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error).toMatchObject({
        code: "target_missing",
        effectStarted: true,
        safety: { possibleCommit: true },
      });
      expect(error.nextStep).toContain("in 5 s");
      expect(error.nextStep).toContain("menu bar");
    }),
);

it.effect("a driver replaced while the launch waits fails with the launch's write safety", () =>
  Effect.gen(function* () {
    const connection = { id: "driver:1" };
    const { host } = fixture(
      {
        launch_app: launched([]),
        list_windows: () => {
          connection.id = "driver:2";
          return { windows: [] };
        },
      },
      connection,
    );
    const fiber = yield* host.invoke(launchCall({}), context).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const error = yield* Fiber.join(fiber);
    expect(error).toMatchObject({
      code: "stale_reference",
      effectStarted: true,
      safety: { possibleCommit: true },
    });
  }),
);

/** A host whose driver answers launch_app with no window and list_windows with `windows()`. */
const timedHost = (windows: () => Effect.Effect<unknown>) =>
  createDesktopTargetHost({
    primitiveChannel: {
      request: (request: { tool: string }) =>
        (request.tool === "list_windows" ? windows() : Effect.succeed(launched([]))).pipe(
          Effect.map(
            (value) =>
              ({
                status: "settled",
                connectionGeneration: "driver:1",
                result: { structuredContent: value },
              }) as unknown as ComputerUsePrimitiveReply,
          ),
        ),
    } as unknown as ComputerUsePrimitiveChannel["Service"],
    leases: {
      currentControl: () => Effect.succeedSome({ controlId: "control" }),
    } as unknown as ComputerUseLeases["Service"],
    platform: "darwin",
  });

it.effect("a window check started inside the 5 s wait still binds when it answers slowly", () =>
  Effect.gen(function* () {
    let polls = 0;
    const host = timedHost(() =>
      // A normal answer near the end of list_windows' 2 s cap.
      Effect.sleep("1900 millis").pipe(
        Effect.map(() => ({ windows: ++polls < 3 ? [] : [document] })),
      ),
    );
    const fiber = yield* host.invoke(launchCall({}), context).pipe(Effect.forkChild);
    // Checks start at 0.1, 2.1 and 4.1 s; the last answers at 6.0 s, past the 5 s wait.
    yield* TestClock.adjust("6 seconds");
    const bound = yield* Fiber.join(fiber);
    expect(bound.value).toMatchObject({ launched: true, windowId: 7 });
    expect(polls).toBe(3);
  }),
);

it.effect("no window check starts once the 5 s wait has passed", () =>
  Effect.gen(function* () {
    const starts: number[] = [];
    const host = timedHost(() =>
      Clock.currentTimeMillis.pipe(Effect.map((now) => (starts.push(now), { windows: [] }))),
    );
    const fiber = yield* host.invoke(launchCall({}), context).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ code: "target_missing", effectStarted: true });
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.max(...starts)).toBeLessThan(5_000);
  }),
);

it.effect(
  "a window list cut at the channel cap fails the wait instead of reading as no window",
  () =>
    Effect.gen(function* () {
      const host = timedHost(() =>
        Effect.succeed({ message: "Driver reply exceeded the primitive channel limit." }),
      );
      const fiber = yield* host.invoke(launchCall({}), context).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error).toMatchObject({
        code: "target_missing",
        effectStarted: true,
        safety: { possibleCommit: true },
      });
      expect(error.nextStep).toContain("looking for its window failed");
    }),
);

it("launch arguments follow each platform's driver contract", () => {
  const bundle = { bundleId: "org.example.Editor", name: "Editor" };
  expect(launchPlan("darwin", bundle)).toEqual({ args: { bundle_id: "org.example.Editor" } });
  expect(launchPlan("darwin", { path: "/Applications/Editor.app" })).toEqual({
    args: { name: "/Applications/Editor.app" },
  });
  // Linux ignores bundle_id: the list_apps Exec launch_path, else the name.
  expect(
    launchPlan("linux", {
      bundleId: "org.gnome.TextEditor.desktop",
      name: "Text Editor",
      launchPath: "gnome-text-editor",
    }),
  ).toEqual({ args: { launch_path: "gnome-text-editor" } });
  expect(launchPlan("linux", { bundleId: "org.gnome.TextEditor.desktop" })).toEqual({
    args: { name: "org.gnome.TextEditor.desktop" },
  });
  // Windows: a packaged app by its AUMID, which a launch_path would bypass; a desktop app by path.
  const notepad = "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App";
  expect(
    launchPlan("win32", {
      bundleId: notepad,
      launchPath: `shell:appsFolder\\${notepad}`,
    }),
  ).toEqual({ args: { bundle_id: notepad } });
  expect(
    launchPlan("win32", {
      bundleId: "Paint.NET",
      launchPath: "C:\\Program Files\\paint.net\\paintdotnet.exe",
    }),
  ).toEqual({ args: { launch_path: "C:\\Program Files\\paint.net\\paintdotnet.exe" } });
  expect(launchPlan("linux", { path: "/opt/Editor.app" })).toMatchObject({ code: "unsupported" });
});

it.live(
  "T60: screen.app('Editor') normalizes a string query to {name}, launches or binds a single window, refuses empty strings, and keeps multi-window/process/bundle ambiguity",
  () => {
    const closedFix = fixture({
      list_apps: { apps: [installed] },
      launch_app: launched([document]),
    });
    const runningSingle = fixture({
      list_apps: { apps: [running] },
      list_windows: { windows: [document] },
    });
    const multiWin = fixture({
      list_apps: { apps: [running] },
      list_windows: { windows: [document, { ...document, window_id: 8, title: "Second" }] },
    });
    const multiProc = fixture({
      list_apps: { apps: [running, { ...running, pid: 99 }] },
    });
    const sharedName = fixture({
      list_apps: { apps: [installed, { ...installed, bundle_id: "com.other.Editor" }] },
    });
    return Effect.gen(function* () {
      const launchedRes = yield* cell(
        closedFix.host,
        "const app = await screen.app('Editor'); return { launched: app.launched, windowId: app.windowId };",
      );
      expect(launchedRes.value).toEqual({ launched: true, windowId: 7 });

      const boundRes = yield* cell(
        runningSingle.host,
        "const app = await screen.app('  Editor  '); return { launched: app.launched, windowId: app.windowId };",
      );
      expect(boundRes.value).toEqual({ launched: false, windowId: 7 });

      const emptyRes = yield* cell(runningSingle.host, caught("await screen.app('   ');"));
      expect(emptyRes.value).toMatchObject({ code: "invalid_argument", nothingSent: true });

      for (const ambFix of [multiWin, multiProc, sharedName]) {
        const ambRes = yield* cell(ambFix.host, caught("await screen.app('Editor');"));
        expect(ambRes.value).toMatchObject({ code: "target_ambiguous", nothingSent: true });
      }
      expect(SCREEN_TARGET_API).toContain("app(q: string | {");
      expect(SCREEN_TARGET_API).toContain(
        'type Done = { ok: true; verdict: "confirmed" | "unverifiable" | "suspected_noop";',
      );
    });
  },
);

it.live(
  "an app already running as two processes names each pid and window, and launches nothing",
  () => {
    const { host, sent } = fixture({
      list_apps: { apps: [running, { ...running, pid: 43 }] },
      list_windows: (args: unknown) => ({
        windows:
          (args as { pid?: number }).pid === 43
            ? [{ ...document, pid: 43, window_id: 8, is_on_screen: false }]
            : [document],
      }),
    });
    return Effect.gen(function* () {
      const result = yield* cell(
        host,
        caught("await screen.app({bundle_id: 'org.example.Editor'});"),
      );
      expect(result.value).toMatchObject({ code: "target_ambiguous", nothingSent: true });
      const message = (result.value as { message: string }).message;
      expect(message).toContain("pid 42 window_id 7");
      expect(message).toContain("pid 43 window_id 8 (off screen)");
      expect(tools(sent)).not.toContain("launch_app");
    });
  },
);

it.live(
  "once an app runs, the next screen.app binds its process and never launches it again",
  () => {
    let started = false;
    const { host, sent } = fixture({
      list_apps: () => ({ apps: [started ? running : installed] }),
      list_windows: () => ({ windows: started ? [document] : [] }),
      launch_app: () => {
        started = true;
        return launched([document]);
      },
    });
    const source =
      "const app = await screen.app({bundle_id: 'org.example.Editor'}); return {launched: app.launched, windowId: app.windowId};";
    return Effect.gen(function* () {
      const first = yield* cell(host, source);
      const second = yield* cell(host, source);
      expect(first.value).toEqual({ launched: true, windowId: 7 });
      expect(second.value).toEqual({ launched: false, windowId: 7 });
      expect(tools(sent).filter((tool) => tool === "launch_app")).toHaveLength(1);
    });
  },
);
