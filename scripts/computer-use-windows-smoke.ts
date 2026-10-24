#!/usr/bin/env node
// Live smoke for GOAT computer use on Windows: the built helper, the pinned driver it runs, and
// the protocol mapping in @goat/shared, against harmless windows only.
//
//   node scripts/build-computer-use-helper-windows.ts --channel dev
//   node scripts/computer-use-windows-smoke.ts --out <dir>
//
// Run it on the signed-in desktop; over SSH or as a service Windows has no desktop (Session 0)
// and the helper refuses. It drives scripts/computer-use-windows-fixture.cs, then Calculator
// only when it was not running, closes only what it opened (Calculator through its own close
// button), exits non-zero when any expected result or refusal is missing, and writes
// screenshots and transcript.json to --out.
// @effect-diagnostics nodeBuiltinImport:off -- A standalone harness around child processes and files.
// @effect-diagnostics globalTimers:off -- Waits for windows the harness itself opened.
// @effect-diagnostics globalConsole:off -- Prints progress to the person running it by hand.
// @effect-diagnostics globalDate:off -- Times the gap between live frames the helper sends.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import {
  computerUseImageInfo,
  PREVIEW_SESSION_FRAME_LIMITS,
  type ComputerUseElement,
  type ComputerUseObservation,
} from "@goat/contracts";
import {
  makeObservationTracker,
  type DriverWindowState,
} from "@goat/shared/computerUseObservation";
import {
  windowsComputerUseReadiness,
  windowsDriverRead,
  windowsObservationTarget,
  WindowsElementStates,
  WindowsHelperReadiness,
  WindowsWindowFacts,
} from "@goat/shared/computerUseWindows";
import * as Schema from "effect/Schema";

import { pidsSafeToClose } from "./lib/windows-shared-hosts.ts";

const decodeReadiness = Schema.decodeUnknownSync(WindowsHelperReadiness);
const decodeFacts = Schema.decodeUnknownSync(WindowsWindowFacts);
const decodeStates = Schema.decodeUnknownSync(WindowsElementStates);

const repo = NodePath.resolve(import.meta.dirname, "..");
const outIndex = process.argv.indexOf("--out");
const out = NodePath.resolve(
  outIndex > 0 ? (process.argv[outIndex + 1] ?? "") : "computer-use-smoke",
);
const helperDir = NodePath.join(repo, "apps/desktop/.computer-use-helper/computer-use-helper");
const frameworkDir = NodePath.join(
  process.env.WINDIR ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
);
NodeFS.mkdirSync(out, { recursive: true });

const transcript: Array<{ readonly step: string; readonly detail: unknown }> = [];
const record = (step: string, detail: unknown) => {
  transcript.push({ step, detail });
  console.log(step, JSON.stringify(detail).slice(0, 300));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string): never => {
  throw new Error(message);
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const processes = (filter: ReadonlyArray<string> = []) =>
  [
    ...NodeChildProcess.execFileSync("tasklist", [...filter, "/fo", "csv", "/nh"])
      .toString()
      .matchAll(/"([^"]+)","(\d+)"/gu),
  ].map((match) => ({ image: match[1] ?? "", pid: Number(match[2]) }));
const pidsOf = (image: string) => processes(["/fi", "imagename eq " + image]).map(({ pid }) => pid);

interface Helper {
  readonly call: (method: string, params?: object) => Promise<unknown>;
  /** frame and frameUnavailable lines; returns the unsubscribe. */
  readonly onFrame: (listener: (message: Record<string, unknown>) => void) => () => void;
  readonly close: () => Promise<void>;
}

async function openHelper(): Promise<Helper> {
  const child = NodeChildProcess.spawn(NodePath.join(helperDir, "GOAT Computer Use.exe"), [], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const pending = new Map<string, (reply: { result?: unknown; error?: unknown }) => void>();
  const frameListeners = new Set<(message: Record<string, unknown>) => void>();
  let greet: (hello: Record<string, unknown>) => void = () => undefined;
  const hello = new Promise<Record<string, unknown>>((resolve) => (greet = resolve));
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "hello" || message.type === "refused") return greet(message);
    if (message.type === "frame" || message.type === "frameUnavailable")
      for (const listener of frameListeners) listener(message);
    if (typeof message.id === "string") pending.get(message.id)?.(message);
  });
  const greeting = await hello;
  record("hello", greeting);
  if (greeting.type !== "hello") fail("The helper refused: " + JSON.stringify(greeting));
  if (!(greeting.features as ReadonlyArray<string> | undefined)?.includes("frames"))
    fail("The helper does not offer live frames.");
  let next = 0;
  const call = async (method: string, params: object = {}) => {
    const id = String(++next);
    const reply = await new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    if (reply.error) fail(method + " failed: " + JSON.stringify(reply.error));
    return reply.result;
  };
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    call,
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    close: async () => {
      child.stdin.end();
      await exited;
    },
  };
}

type Elements = ReadonlyArray<ComputerUseElement>;
const fullElements = (observation: ComputerUseObservation): Elements =>
  observation.kind === "full" ? observation.elements : fail("Expected a full observation.");
const labelled = (elements: Elements, pattern: RegExp) =>
  elements.find((element) => pattern.test(element.label ?? "")) ?? fail("No element " + pattern);

async function main(
  opened: Array<{ readonly pid: number; readonly image: string }>,
  closeButtons: Array<() => Promise<unknown>>,
) {
  const helper = await openHelper();
  try {
    const readiness = windowsComputerUseReadiness({
      facts: decodeReadiness(await helper.call("permissions")),
      helper: "authenticated",
    });
    record("readiness before any read", readiness);
    if (readiness.blockers.length > 0)
      fail("This desktop cannot be used: " + readiness.reasons.join(" "));

    const pipe = "\\\\.\\pipe\\goat-cu-smoke-" + process.pid;
    const started = (await helper.call("start", { socketPath: pipe, noOverlay: true })) as {
      driverPid: number;
    };
    record("start", started);
    const sdk = NodePath.join(repo, "apps/desktop/node_modules/@trycua/cua-driver/dist/index.js");
    const { CuaDriver } = await import(NodeURL.pathToFileURL(sdk).href);
    const driver = CuaDriver.connect(pipe);
    const tool = async (name: string, args: object) => {
      const result = await driver.callTool(name, JSON.stringify(args));
      return {
        isError: Boolean(result.isError),
        text: String(result.text),
        structured: JSON.parse(result.structuredJson || "null"),
        images: (result.images ?? []) as ReadonlyArray<{ dataBase64: string }>,
      };
    };
    let id = 0;
    const tracker = makeObservationTracker(() => "o" + ++id);

    const observe = async (label: string, pid: number, windowId: number, since?: string) => {
      const target = windowsObservationTarget(
        decodeFacts(await helper.call("window", { pid, windowId })),
      );
      if ("outcome" in target) return fail("Refused " + label + ": " + target.message);
      // Nothing is read while a password field has focus.
      const read = target.privateMode
        ? undefined
        : await tool("get_window_state", { pid, window_id: windowId, tree_format: "elements" });
      const states = read
        ? decodeStates(await helper.call("elementStates", { pid, windowId }))
        : undefined;
      if (states)
        record("element states " + label, {
          count: states.elements.length,
          truncated: states.truncated,
        });
      const image = read?.images[0];
      if (image)
        NodeFS.writeFileSync(
          NodePath.join(out, label + ".png"),
          Buffer.from(image.dataBase64, "base64"),
        );
      const observation = tracker.observe({
        read: windowsDriverRead(
          (read?.structured ?? { pid, window_id: windowId }) as DriverWindowState,
          states,
        ),
        since,
        epoch: target.epoch,
        scope: "default",
        screenshot: !target.privateMode,
        privateMode: target.privateMode,
      });
      record("observe " + label, observation);
      return observation;
    };
    let framesId = 0;
    /**
     * One frames request for one window (#1370), cleared again before returning. A frame must be
     * a JPEG of exactly the size it claims, within the tile limits, and come no faster than the
     * interval; a no-picture reason must be the expected one and be told once. Nothing may arrive
     * for the request after it is cleared.
     */
    const frame = async (
      label: string,
      expected: string,
      target: {
        readonly pid: number;
        readonly windowId: number;
        readonly maxWidth: number;
        readonly apps?: ReadonlyArray<string>;
      },
    ) => {
      const id = ++framesId;
      const seen: Array<{ readonly at: number; readonly message: Record<string, unknown> }> = [];
      const unsubscribe = helper.onFrame((message) => {
        if (message.framesId === id) seen.push({ at: Date.now(), message });
      });
      const params = { key: label, intervalMs: 500, ...target };
      await helper.call("frames", { framesId: id, targets: [params] });
      const wanted = expected === "frame" ? 2 : 1;
      for (let attempt = 0; attempt < 60 && seen.length < wanted; attempt++) await sleep(250);
      // A reason is told once, however many intervals pass.
      if (expected !== "frame") await sleep(1_200);
      await helper.call("frames", { framesId: ++framesId, targets: [] });
      const cleared = seen.length;
      await sleep(1_200);
      unsubscribe();
      const first = seen[0]?.message ?? fail("No frames answer for " + label + ".");
      if (seen.length !== cleared) fail("Frames for " + label + " kept coming after the clear.");
      if (first.type === "frameUnavailable") {
        record("frame " + label, first);
        if (first.reason !== expected || seen.length !== 1)
          fail("frames " + label + " should be " + expected + " once, got " + JSON.stringify(seen));
        return;
      }
      const data = String(first.data);
      const bytes = Buffer.from(data, "base64");
      const info = computerUseImageInfo(data);
      const gap = (seen[1]?.at ?? Infinity) - (seen[0]?.at ?? 0);
      record("frame " + label, {
        width: first.width,
        height: first.height,
        bytes: bytes.length,
        gap,
      });
      NodeFS.writeFileSync(NodePath.join(out, "frame-" + label + ".jpg"), bytes);
      if (
        expected !== "frame" ||
        first.key !== label ||
        info?.mimeType !== "image/jpeg" ||
        info.width !== first.width ||
        info.height !== first.height ||
        info.width > Math.min(PREVIEW_SESSION_FRAME_LIMITS.maxWidth, params.maxWidth) ||
        bytes.length > PREVIEW_SESSION_FRAME_LIMITS.maxBytes ||
        // Two frames, at least about one interval apart.
        !(gap >= 450 && gap < 5_000)
      )
        fail(
          "frames " + label + " should be " + expected + ", got " + JSON.stringify({ info, gap }),
        );
    };
    /** One element action through a tracker ref. A refusal is returned and nothing is sent. */
    const act = async (
      name: string,
      pid: number,
      windowId: number,
      observationId: string,
      ref: string,
      extra: object = {},
    ) => {
      const resolved = tracker.resolve({ pid, windowId, observationId, element: ref });
      if (!("token" in resolved)) {
        record("refused " + name, resolved);
        return { refusal: resolved };
      }
      const result = await tool(name, {
        pid,
        window_id: windowId,
        element_token: resolved.token,
        ...extra,
      });
      record(name, {
        isError: result.isError,
        effect: result.structured?.effect,
        text: result.text,
      });
      return { isError: result.isError };
    };
    /** The action must reach the driver and the driver must not report an error. */
    const sent = async (...args: Parameters<typeof act>) => {
      const result = await act(...args);
      if (result.refusal || result.isError !== false) fail(args[0] + " did not reach the window.");
    };
    /** The action must be refused for exactly this reason, before anything is sent. */
    const refused = async (reason: string, ...args: Parameters<typeof act>) => {
      const result = await act(...args);
      if (result.refusal?.reason !== reason)
        fail(
          args[0] + " should have been refused as " + reason + ", got " + JSON.stringify(result),
        );
    };
    const windowOf = async (pids: ReadonlyArray<number>, title: RegExp) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const listed =
          (await tool("list_windows", { on_screen_only: true })).structured?.windows ?? [];
        const found = (listed as Array<{ pid: number; window_id: number; title: string }>).find(
          (window) => (pids.length === 0 || pids.includes(window.pid)) && title.test(window.title),
        );
        if (found) return found;
        await sleep(250);
      }
      return fail("No window " + title);
    };

    try {
      // 1. The fixture: observe, act, observe the change, then private mode.
      const fixtureExe = NodePath.join(out, "computer-use-windows-fixture.exe");
      NodeChildProcess.execFileSync(NodePath.join(frameworkDir, "csc.exe"), [
        "/nologo",
        "/target:winexe",
        "/out:" + fixtureExe,
        "/r:System.Windows.Forms.dll",
        "/r:System.Drawing.dll",
        NodePath.join(repo, "scripts", "computer-use-windows-fixture.cs"),
      ]);
      const fixture = NodeChildProcess.spawn(fixtureExe, [], { stdio: "ignore" });
      opened.push({
        pid: fixture.pid ?? fail("The fixture did not start."),
        image: NodePath.basename(fixtureExe),
      });
      const fw = await windowOf([fixture.pid ?? 0], /GOAT computer use fixture/u);
      const fixtureTarget = { pid: fw.pid, windowId: fw.window_id };
      // The app name the driver lists for the fixture, which an approval would carry.
      const listed = (
        (await helper.call("listApps")) as { apps: Array<{ pid: number; name: string }> }
      ).apps;
      const fixtureApp =
        listed.find((app) => app.pid === fw.pid)?.name ??
        fail("list_apps does not name the fixture.");
      await frame("fixture", "frame", { ...fixtureTarget, maxWidth: 480 });
      await frame("fixture-narrow", "frame", { ...fixtureTarget, maxWidth: 200 });
      await frame("fixture-approved", "frame", {
        ...fixtureTarget,
        maxWidth: 480,
        apps: [fixtureApp],
      });
      await frame("fixture-other-app", "appNotApproved", {
        ...fixtureTarget,
        maxWidth: 480,
        apps: ["Calculator"],
      });
      await frame("wrong-pid", "windowGone", {
        pid: process.pid,
        windowId: fw.window_id,
        maxWidth: 480,
      });
      // Past a Windows pid's range: no process has it, so it is gone, not a malformed request.
      await frame("pid-out-of-range", "windowGone", {
        pid: 2 ** 40,
        windowId: fw.window_id,
        maxWidth: 480,
      });
      const first = await observe("fixture-1", fw.pid, fw.window_id);
      const firstElements = fullElements(first);
      // State the driver gives (Agree's ToggleState) and what only the helper reads (#1286).
      const states = ["Agree", "Mixed", "unnamedMixed", "Size"].map(
        (name) => labelled(firstElements, new RegExp("^" + name + "$", "u")).state,
      );
      if (
        JSON.stringify(states) !==
        JSON.stringify([
          { enabled: true, checked: false },
          { enabled: true, checked: "mixed" },
          { enabled: true, checked: "mixed" },
          { enabled: true, expanded: false },
        ])
      )
        fail("Unexpected element state: " + JSON.stringify(states));
      await sent(
        "set_value",
        fw.pid,
        fw.window_id,
        first.observationId,
        labelled(firstElements, /^Note$/u).ref,
        { value: "hello from GOAT" },
      );
      await sent(
        "click",
        fw.pid,
        fw.window_id,
        first.observationId,
        labelled(firstElements, /^Add one$/u).ref,
      );
      const second = await observe("fixture-2", fw.pid, fw.window_id, first.observationId);
      const note = labelled(firstElements, /^Note$/u).ref;
      if (
        second.kind !== "diff" ||
        !second.changed.some(
          (element) => element.ref === note && element.value === "hello from GOAT",
        )
      )
        fail("The diff after set_value does not show Note's new value under the same ref.");
      await refused(
        "staleElement",
        "click",
        fw.pid,
        fw.window_id,
        first.observationId,
        labelled(firstElements, /^Add one$/u).ref,
      );
      const full = await observe("fixture-3", fw.pid, fw.window_id);
      await sent(
        "click",
        fw.pid,
        fw.window_id,
        full.observationId,
        labelled(fullElements(full), /^Focus secret$/u).ref,
      );
      await sleep(500);
      const hidden = await observe("fixture-4-private", fw.pid, fw.window_id, full.observationId);
      if (
        !hidden.privateMode ||
        hidden.kind !== "full" ||
        hidden.elements.length > 0 ||
        hidden.screenshot !== undefined
      )
        fail("A focused password field must withhold the whole window.");
      await frame("fixture-private", "private", { ...fixtureTarget, maxWidth: 480 });
      await refused(
        "privateMode",
        "set_value",
        fw.pid,
        fw.window_id,
        hidden.observationId,
        labelled(fullElements(full), /^Secret$/u).ref,
        { value: "never sent" },
      );
      // Leaving the field needs an element the agent cannot address now; the fixture's own
      // button stands in for the person moving focus.
      const raw = await tool("get_window_state", {
        pid: fw.pid,
        window_id: fw.window_id,
        tree_format: "elements",
        include_screenshot: false,
      });
      const leave = (raw.structured?.elements ?? []).find(
        (element: { label?: string }) => element.label === "Leave secret",
      );
      await tool("click", {
        pid: fw.pid,
        window_id: fw.window_id,
        element_token: leave?.element_token ?? fail("No Leave secret button"),
      });
      await sleep(500);
      const again = await observe(
        "fixture-5-public-again",
        fw.pid,
        fw.window_id,
        hidden.observationId,
      );
      if (again.privateMode) fail("Private mode did not end when focus left the password field.");

      // Notepad is not used: it restores unsaved tabs and open files on its next start, so any
      // run would leave text behind for the person who uses this computer.

      // 2. Calculator, only when it was not running; closed through its own close button.
      if (pidsOf("CalculatorApp.exe").length === 0) {
        NodeChildProcess.spawn("calc.exe", [], { stdio: "ignore", detached: true }).unref();
        const cw = await windowOf([], /^(Calculator|계산기)$/u);
        // Registered before anything can fail, so a failed step still closes it.
        closeButtons.push(async () => {
          const last = await observe("calculator-close", cw.pid, cw.window_id);
          const close =
            fullElements(last).find(
              (element) => element.role === "Button" && /(Close|닫기)/u.test(element.label ?? ""),
            ) ?? fail("Calculator has no close button; it is still open.");
          await sent("click", cw.pid, cw.window_id, last.observationId, close.ref);
          // Closed means this exact window is gone, not that the click was sent.
          for (let attempt = 0; attempt < 20; attempt++) {
            // Only a successful listing can show the window is gone.
            const listing = await tool("list_windows", {});
            const listed: unknown = listing.structured?.windows;
            if (listing.isError || !Array.isArray(listed))
              fail("Could not list windows to confirm Calculator closed.");
            if (
              !(listed as Array<{ window_id: number }>).some(
                (window) => window.window_id === cw.window_id,
              )
            )
              return;
            await sleep(250);
          }
          fail("Calculator's window is still open after its close button.");
        });
        for (const button of [/^1$/u, /^(Plus|더하기)$/u, /^2$/u, /^(Equals|일치)$/u]) {
          const step = await observe("calculator-step", cw.pid, cw.window_id);
          await sent(
            "click",
            cw.pid,
            cw.window_id,
            step.observationId,
            labelled(fullElements(step), button).ref,
          );
        }
        const result = await observe("calculator-2", cw.pid, cw.window_id);
        const display = fullElements(result)
          .filter((element) => /^(Display is|표시는)/u.test(element.label ?? ""))
          .map((element) => element.label);
        record("calculator display", display);
        if (!display.some((label) => /(^| )3$/u.test(label ?? "")))
          fail("Calculator does not show 3 after 1 + 2 =.");
      } else record("calculator", "already running; skipped");
    } finally {
      // While the helper and driver still run, so windows close through their own buttons.
      // Every close is tried; any that failed fails the run afterwards.
      const failedCloses: string[] = [];
      for (const close of closeButtons.splice(0))
        await close().catch((error: unknown) => {
          record("close failed", String(error));
          failedCloses.push(String(error));
        });
      driver.uniffiDestroy?.();
      await helper.call("stop").catch(() => undefined);
      record("driver alive after stop", alive(started.driverPid));
      if (failedCloses.length > 0) fail("Cleanup failed: " + failedCloses.join("; "));
    }
  } finally {
    await helper.close();
  }
}

const runningBefore = new Set(processes().map(({ pid }) => pid));
const opened: Array<{ readonly pid: number; readonly image: string }> = [];
const closeButtons: Array<() => Promise<unknown>> = [];
try {
  await main(opened, closeButtons);
} catch (error) {
  record("failed", error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  // Only what this run opened, and never a shared window host such as Calculator's (#1247).
  for (const pid of pidsSafeToClose(opened, runningBefore)) {
    try {
      process.kill(pid);
    } catch {
      // Already closed.
    }
  }
  await sleep(500);
  record(
    "left running",
    opened.filter(({ pid }) => alive(pid)),
  );
  NodeFS.writeFileSync(NodePath.join(out, "transcript.json"), JSON.stringify(transcript, null, 1));
}
