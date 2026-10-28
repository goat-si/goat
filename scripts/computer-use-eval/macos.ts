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

const ownerWindows = (owner: string) =>
  CG_WINDOWS +
  "JSON.stringify({ windows: cgWindows().filter((w) => w.owner === " +
  JSON.stringify(owner) +
  ").map(({ id, title }) => ({ id, title })) })";

/** On-screen, normal-layer windows of every app. */
export const windowInventory = async () => {
  const value = await jxa(CG_WINDOWS + "JSON.stringify({ windows: cgWindows() })");
  return (value["windows"] as ReadonlyArray<{ id: number; owner: string; title: string }>) ?? [];
};

// The display's path in Calculator's accessibility tree on macOS 26; null when it moves.
const CALCULATOR =
  "const se = Application('System Events'); const procs = se.processes.whose({ name: 'Calculator' });" +
  "let result = { running: procs.length > 0, display: null };" +
  "if (procs.length > 0 && procs[0].windows.length > 0) { try { result.display = procs[0].windows[0]" +
  ".uiElements[0].uiElements[0].uiElements[1].uiElements[0].uiElements[0].uiElements[0].value(); } catch (e) { result.error = String(e); } }" +
  "JSON.stringify(result)";

const textEdit = (target: string) =>
  "const se = Application('System Events'); const procs = se.processes.whose({ name: 'TextEdit' });" +
  "const windows = procs.length === 0 ? [] : procs[0].windows().map((w) => { let hasTarget = false;" +
  "try { hasTarget = String(w.scrollAreas[0].textAreas[0].value()).includes(" +
  JSON.stringify(target) +
  "); } catch (e) {}" +
  "return { title: w.name(), hasTarget }; });" +
  "JSON.stringify({ running: procs.length > 0, windows })";

const KAKAO =
  CG_WINDOWS +
  "const windows = cgWindows().filter((w) => w.owner === 'KakaoTalk').map(({ id, title }) => ({ id, title }));" +
  "JSON.stringify({ windows, loggedIn: windows.length > 0 && !windows.some((w) => /^(log ?in|로그인)$/i.test(w.title)) })";

/** Task witnesses: each returns one sample of the state its oracle judges. */
export const WITNESSES: Readonly<
  Record<string, (expect: JsonObject) => () => Promise<JsonObject>>
> = {
  calculator: () => () => jxa(CALCULATOR),
  finder: () => () => jxa(ownerWindows("Finder")),
  textEdit: (expect) => () => jxa(textEdit(String(expect["typedText"] ?? ""))),
  kakao: () => () => jxa(KAKAO),
};

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
 * Samples a witness until stopped, keeping a sample only when it differs from the one before.
 * A failed read becomes a sample too, so a broken witness shows in the row.
 */
export const sampleUntil = (read: () => Promise<JsonObject>, intervalMs: number) => {
  const samples: Array<{ atMs: number; value: JsonObject }> = [];
  const start = Date.now();
  const state = { stopped: false };
  let last = "";
  const loop = (async () => {
    while (!state.stopped) {
      const value = await read().catch(
        (error: unknown) => ({ witnessError: String(error) }) as JsonObject,
      );
      const key = JSON.stringify(value);
      if (key !== last) samples.push({ atMs: Date.now() - start, value });
      last = key;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    stop: async () => {
      state.stopped = true;
      await loop;
      return samples;
    },
  };
};
