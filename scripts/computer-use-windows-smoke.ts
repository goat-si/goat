#!/usr/bin/env node
// Live smoke for GOAT computer use on Windows: the built helper, the pinned driver it runs, and
// the protocol mapping in @goat/shared, against harmless windows only.
//
//   node scripts/build-computer-use-helper-windows.ts --channel dev
//   node scripts/computer-use-windows-smoke.ts --out <dir>
//
// Run it on the signed-in desktop; over SSH or as a service Windows has no desktop (Session 0)
// and the helper refuses. It drives scripts/computer-use-windows-fixture.cs, then Notepad and
// Calculator only when neither was running, closes only what it opened (Calculator through its
// own close button), and writes screenshots and transcript.json to --out.
// @effect-diagnostics nodeBuiltinImport:off -- A standalone harness around child processes and files.
// @effect-diagnostics globalTimers:off -- Waits for windows the harness itself opened.
// @effect-diagnostics globalConsole:off -- Prints progress to the person running it by hand.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import type { ComputerUseElement, ComputerUseObservation } from "@goat/contracts";
import {
  makeObservationTracker,
  type DriverWindowState,
} from "@goat/shared/computerUseObservation";
import {
  windowsComputerUseReadiness,
  windowsObservationTarget,
  WindowsHelperReadiness,
  WindowsWindowFacts,
} from "@goat/shared/computerUseWindows";
import * as Schema from "effect/Schema";

import { pidsSafeToClose } from "./lib/windows-shared-hosts.ts";

const decodeReadiness = Schema.decodeUnknownSync(WindowsHelperReadiness);
const decodeFacts = Schema.decodeUnknownSync(WindowsWindowFacts);

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
  readonly close: () => Promise<void>;
}

async function openHelper(): Promise<Helper> {
  const child = NodeChildProcess.spawn(NodePath.join(helperDir, "GOAT Computer Use.exe"), [], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const pending = new Map<string, (reply: { result?: unknown; error?: unknown }) => void>();
  let greet: (hello: Record<string, unknown>) => void = () => undefined;
  const hello = new Promise<Record<string, unknown>>((resolve) => (greet = resolve));
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "hello" || message.type === "refused") return greet(message);
    if (typeof message.id === "string") pending.get(message.id)?.(message);
  });
  const greeting = await hello;
  record("hello", greeting);
  if (greeting.type !== "hello") fail("The helper refused: " + JSON.stringify(greeting));
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
      const image = read?.images[0];
      if (image)
        NodeFS.writeFileSync(
          NodePath.join(out, label + ".png"),
          Buffer.from(image.dataBase64, "base64"),
        );
      const observation = tracker.observe({
        read: (read?.structured ?? { pid, window_id: windowId }) as DriverWindowState,
        since,
        epoch: target.epoch,
        scope: "default",
        screenshot: !target.privateMode,
        privateMode: target.privateMode,
      });
      record("observe " + label, observation);
      return observation;
    };
    /** One element action through a tracker ref; refusals are recorded, never sent. */
    const act = async (
      name: string,
      pid: number,
      windowId: number,
      observationId: string,
      ref: string,
      extra: object = {},
    ) => {
      const resolved = tracker.resolve({ pid, windowId, observationId, element: ref });
      if (!("token" in resolved)) return record("refused " + name, resolved);
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
    const first = await observe("fixture-1", fw.pid, fw.window_id);
    const firstElements = fullElements(first);
    await act(
      "set_value",
      fw.pid,
      fw.window_id,
      first.observationId,
      labelled(firstElements, /^Note$/u).ref,
      { value: "hello from GOAT" },
    );
    await act(
      "click",
      fw.pid,
      fw.window_id,
      first.observationId,
      labelled(firstElements, /^Add one$/u).ref,
    );
    await observe("fixture-2", fw.pid, fw.window_id, first.observationId);
    // An older observation's ref is refused before anything is sent.
    await act(
      "click",
      fw.pid,
      fw.window_id,
      first.observationId,
      labelled(firstElements, /^Add one$/u).ref,
    );
    const full = await observe("fixture-3", fw.pid, fw.window_id);
    await act(
      "click",
      fw.pid,
      fw.window_id,
      full.observationId,
      labelled(fullElements(full), /^Focus secret$/u).ref,
    );
    await sleep(500);
    const hidden = await observe("fixture-4-private", fw.pid, fw.window_id, full.observationId);
    await act(
      "set_value",
      fw.pid,
      fw.window_id,
      hidden.observationId,
      labelled(fullElements(full), /^Secret$/u).ref,
      { value: "never sent" },
    );
    // Leaving the field needs an element the agent cannot address now; the fixture's own
    // button stands in for the person moving focus.
    await tool("click", {
      pid: fw.pid,
      window_id: fw.window_id,
      element_token: (
        await tool("get_window_state", {
          pid: fw.pid,
          window_id: fw.window_id,
          tree_format: "elements",
          include_screenshot: false,
        })
      ).structured.elements.find((element: { label?: string }) => element.label === "Leave secret")
        .element_token,
    });
    await sleep(500);
    await observe("fixture-5-public-again", fw.pid, fw.window_id, hidden.observationId);

    // 2. Notepad, only when none was running.
    if (pidsOf("Notepad.exe").length === 0) {
      NodeChildProcess.spawn("notepad.exe", [], { stdio: "ignore", detached: true }).unref();
      await sleep(2000);
      const notepads = pidsOf("Notepad.exe");
      opened.push(...notepads.map((pid) => ({ pid, image: "Notepad.exe" })));
      const nw = await windowOf(notepads, /.+/u);
      const n1 = await observe("notepad-1", nw.pid, nw.window_id);
      const editor =
        fullElements(n1).find(
          (element) => element.role === "Document" || element.role === "Edit",
        ) ?? fail("Notepad has no editor");
      await act("set_value", nw.pid, nw.window_id, n1.observationId, editor.ref, {
        value: "GOAT computer use smoke",
      });
      await observe("notepad-2", nw.pid, nw.window_id, n1.observationId);
    } else record("notepad", "already running; skipped");

    // 3. Calculator, only when it was not running; closed through its own close button.
    if (pidsOf("CalculatorApp.exe").length === 0) {
      NodeChildProcess.spawn("calc.exe", [], { stdio: "ignore", detached: true }).unref();
      const cw = await windowOf([], /^(Calculator|계산기)$/u);
      for (const button of [/^1$/u, /^(Plus|더하기)$/u, /^2$/u, /^(Equals|일치)$/u]) {
        const step = await observe("calculator-step", cw.pid, cw.window_id);
        await act(
          "click",
          cw.pid,
          cw.window_id,
          step.observationId,
          labelled(fullElements(step), button).ref,
        );
      }
      const result = await observe("calculator-2", cw.pid, cw.window_id);
      record(
        "calculator display",
        fullElements(result)
          .filter((element) => /^(Display is|표시는)/u.test(element.label ?? ""))
          .map((element) => element.label),
      );
      closeButtons.push(async () => {
        const last = await observe("calculator-close", cw.pid, cw.window_id);
        const close = fullElements(last).find(
          (element) => element.role === "Button" && /(Close|닫기)/u.test(element.label ?? ""),
        );
        if (close) await act("click", cw.pid, cw.window_id, last.observationId, close.ref);
      });
    } else record("calculator", "already running; skipped");

    for (const close of closeButtons.splice(0))
      await close().catch((error: unknown) => record("close failed", String(error)));
    driver.uniffiDestroy?.();
    await helper.call("stop");
    record("driver alive after stop", alive(started.driverPid));
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
