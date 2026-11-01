// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - a plain Node helper for the eval runner; no Effect runtime.
/**
 * What the computer use eval observes on this Mac, independently of the arm under test. Reads go
 * through System Events and CoreGraphics only: scripting an app directly (tell application
 * "Finder") raises a per-app Automation prompt that only a person can answer.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type JsonObject } from "../agent-surface/eval/core.ts";

/** Runs a JXA program from stdin and parses the JSON its last expression returns. */
export const jxa = (source: string, timeoutMs = 15000): Promise<JsonObject> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("osascript", ["-l", "JavaScript"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("osascript timed out after " + timeoutMs + " ms"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error("osascript exited " + code + ": " + err.trim().slice(0, 300)));
      try {
        resolve(JSON.parse(out) as JsonObject);
      } catch {
        reject(new Error("osascript printed no JSON: " + out.slice(0, 200)));
      }
    });
    child.stdin.end(source);
  });

const CG_WINDOWS =
  "ObjC.import('CoreGraphics');" +
  "const cgWindows = () => ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0)))" +
  ".filter((w) => w.kCGWindowLayer === 0)" +
  ".map((w) => ({ id: w.kCGWindowNumber, owner: w.kCGWindowOwnerName, title: w.kCGWindowName || '' }));";

/** On-screen, normal-layer windows of every app. */
export const windowInventory = async () => {
  const value = await jxa(CG_WINDOWS + "JSON.stringify({ windows: cgWindows() })");
  return (value["windows"] as ReadonlyArray<{ id: number; owner: string; title: string }>) ?? [];
};

// The display group's path in Calculator's accessibility tree on macOS 26. After "=" the
// expression and the result sit in separate scroll areas, so every text there is read.
const CALCULATOR =
  "const procs = se.processes.whose({ name: 'Calculator' });" +
  "const result = { running: procs.length > 0, display: null, texts: [] };" +
  "if (procs.length > 0 && procs[0].windows.length > 0) { try {" +
  "const group = procs[0].windows[0].uiElements[0].uiElements[0].uiElements[1].uiElements[0];" +
  "const texts = group.scrollAreas().flatMap((area) => area.staticTexts().map((t) => ({ value: String(t.value()), description: String(t.description()) })));" +
  "result.texts = texts.map((t) => t.value);" +
  "const field = texts.find((t) => t.description === 'Edit field') || texts[texts.length - 1];" +
  "result.display = field ? field.value : null; } catch (e) { result.error = String(e); } }" +
  "return result;";

// CoreGraphics gives each window a stable id and System Events its text; they meet on the title,
// so text is unknown (null) for windows whose title is not unique.
const textEdit = (target: string) =>
  "const procs = se.processes.whose({ name: 'TextEdit' });" +
  "const texts = procs.length === 0 ? [] : procs[0].windows().map((w) => { let hasTarget = null; let print = null;" +
  "try { const text = String(w.scrollAreas[0].textAreas[0].value()); hasTarget = text.includes(" +
  JSON.stringify(target) +
  "); let h = 5381; for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0; print = text.length + ':' + h; } catch (e) {}" +
  "return { title: w.name(), hasTarget, print }; });" +
  "const own = cgWindows().filter((w) => w.owner === 'TextEdit');" +
  "return { running: procs.length > 0, windows: own.map(({ id, title }) => { const same = texts.filter((t) => t.title === title);" +
  "const unique = same.length === 1 && own.filter((w) => w.title === title).length === 1;" +
  "return { id, title, hasTarget: unique ? same[0].hasTarget : null, print: unique ? same[0].print : null }; }) };";

const ownerWindows = (owner: string) =>
  "return { windows: cgWindows().filter((w) => w.owner === " +
  JSON.stringify(owner) +
  ").map(({ id, title }) => ({ id, title })) };";

const PRELUDE = CG_WINDOWS + "const se = Application('System Events');";

export interface Witness {
  /** A JXA function body that returns one sample. */
  readonly body: string;
  /** How often the observer samples during a run. */
  readonly intervalMs: number;
}

/** Task witnesses: each samples the state its oracle judges. */
export const WITNESSES: Readonly<Record<string, (expect: JsonObject) => Witness>> = {
  calculator: () => ({ body: CALCULATOR, intervalMs: 50 }),
  finder: () => ({ body: ownerWindows("Finder"), intervalMs: 250 }),
  textEdit: (expect) => ({ body: textEdit(String(expect["typedText"] ?? "")), intervalMs: 250 }),
};

/** One sample, read once. */
export const readWitness = (witness: Witness) =>
  jxa(PRELUDE + "JSON.stringify((() => {" + witness.body + "})())");

/** Tab counts of Chrome's on-screen windows, read from its tab strip. */
export const chromeTabCount = async (): Promise<number | null> => {
  const value = await jxa(
    "const se = Application('System Events'); const procs = se.processes.whose({ name: 'Google Chrome' });" +
      "let total = null; if (procs.length > 0) { total = 0; procs[0].windows().forEach((w) => {" +
      "const walk = (e, d) => { if (d > 7) return; let kids = []; try { kids = e.uiElements(); } catch (_) { return; }" +
      "kids.forEach((k) => { let role = ''; try { role = k.role(); } catch (_) {}" +
      "if (role === 'AXTabGroup') { try { total += k.uiElements().filter((t) => { try { return t.role() === 'AXRadioButton'; } catch (_) { return false; } }).length; } catch (_) {} } else walk(k, d + 1); }); };" +
      "walk(w, 0); }); } JSON.stringify({ total })",
    30000,
  );
  return typeof value["total"] === "number" ? value["total"] : null;
};

const SAVE_DIRS = [
  "Documents",
  "Desktop",
  "Downloads",
  "Library/Mobile Documents/com~apple~TextEdit/Documents",
];

/** Document files created or changed since a moment, by name only; their contents are not read. */
export const documentsSince = (sinceMs: number): ReadonlyArray<string> =>
  SAVE_DIRS.flatMap((dir) => {
    const root = NodePath.join(NodeOS.homedir(), dir);
    let names: ReadonlyArray<string> = [];
    try {
      names = NodeFS.readdirSync(root);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      if (!/\.(rtf|rtfd|txt)$/iu.test(name)) return [];
      try {
        return NodeFS.statSync(NodePath.join(root, name)).mtimeMs >= sinceMs
          ? [NodePath.join(dir, name)]
          : [];
      } catch {
        return [];
      }
    });
  });

/**
 * Samples a witness until stopped from one long-lived osascript, so a short state, such as a
 * result shown and cleared within one cell, is still caught. Only changes are kept, and a failed
 * read becomes a sample too, so a broken witness shows in the row.
 */
export const sampleUntil = (witness: Witness) => {
  const samples: Array<{ atMs: number; value: JsonObject }> = [];
  const start = Date.now();
  const child = NodeChildProcess.spawn("osascript", ["-l", "JavaScript"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let buffer = "";
  let last = "";
  child.stderr.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("{") || line === last) continue;
      last = line;
      try {
        samples.push({ atMs: Date.now() - start, value: JSON.parse(line) as JsonObject });
      } catch {
        samples.push({ atMs: Date.now() - start, value: { witnessError: line.slice(0, 200) } });
      }
    }
  });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  // console.log in osascript writes to stderr.
  child.stdin.end(
    PRELUDE +
      "while (true) { let line; try { line = JSON.stringify((() => {" +
      witness.body +
      "})()); } catch (e) { line = JSON.stringify({ witnessError: String(e) }); } console.log(line); delay(" +
      witness.intervalMs / 1000 +
      "); }",
  );
  return {
    stop: async () => {
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        child.kill(signal);
        const ended = await Promise.race([
          closed.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
        ]);
        if (ended) break;
      }
      if (child.exitCode === null && child.signalCode === null)
        throw new Error("the observer process " + child.pid + " did not stop");
      return samples;
    },
  };
};
