import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class BrowserClaimWindowsUnavailable extends Schema.TaggedError<BrowserClaimWindowsUnavailable>()(
  "BrowserClaimWindowsUnavailable",
  { cause: Schema.Defect() },
) {}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const content = (value: unknown) =>
  record(value) && record(value.structuredContent) ? value.structuredContent : undefined;
const browserIds = new Set([
  "com.google.chrome",
  "com.google.chrome.beta",
  "com.google.chrome.dev",
  "com.google.chrome.canary",
  "com.microsoft.edgemac",
  "com.microsoft.edgemac.beta",
  "com.microsoft.edgemac.dev",
  "com.microsoft.edgemac.canary",
  "org.chromium.chromium",
  "google-chrome",
  "google-chrome.desktop",
  "chromium",
  "chromium.desktop",
  "chromium-browser",
  "chromium-browser.desktop",
  "microsoft-edge",
  "microsoft-edge.desktop",
  "chrome.exe",
  "msedge.exe",
  "chromium.exe",
]);
const isBrowser = (app: Record<string, unknown>) => {
  const id =
    typeof app.bundle_id === "string" && app.bundle_id
      ? app.bundle_id
      : typeof app.launch_path === "string"
        ? app.launch_path.split(/[\\/]/).pop()
        : undefined;
  return id !== undefined && browserIds.has(id.toLowerCase());
};
type DriverRequest = (
  tool: "list_apps" | "list_windows",
  args: Record<string, number>,
) => Effect.Effect<unknown, Error>;
export const listBrowserClaimWindows = Effect.fn("BrowserClaimWindows.list")(function* (
  request: DriverRequest,
) {
  const appsReply = yield* request("list_apps", {}).pipe(
    Effect.mapError((cause) => new BrowserClaimWindowsUnavailable({ cause })),
  );
  const apps = content(appsReply)?.apps;
  if ((record(appsReply) && appsReply.isError === true) || !Array.isArray(apps))
    return yield* new BrowserClaimWindowsUnavailable({
      cause: "Cannot list browser applications.",
    });
  const windows: Array<{ pid: number; windowId: number; title: string; app: string }> = [];
  const refused: Array<{
    pid: number;
    app: string;
    reason: "browser_process_protected" | "outside_manifest";
  }> = [];
  for (const app of apps) {
    if (
      !record(app) ||
      !isBrowser(app) ||
      app.running !== true ||
      !Number.isSafeInteger(app.pid) ||
      typeof app.pid !== "number" ||
      app.pid <= 0 ||
      typeof app.name !== "string"
    )
      continue;
    const pid = app.pid;
    const name = app.name;
    const reply = yield* request("list_windows", { pid }).pipe(
      Effect.mapError((cause) => new BrowserClaimWindowsUnavailable({ cause })),
    );
    const body = content(reply);
    const code = record(body?.refusal) ? body.refusal.code : body?.code;
    if (
      code === "browser_process_protected" ||
      code === "outside_manifest" ||
      code === "bounded_resource_outside_manifest"
    ) {
      refused.push({
        pid,
        app: name,
        reason: code === "browser_process_protected" ? code : "outside_manifest",
      });
      continue;
    }
    if ((record(reply) && reply.isError === true) || !Array.isArray(body?.windows))
      return yield* new BrowserClaimWindowsUnavailable({ cause: "Cannot list browser windows." });
    for (const window of body.windows) {
      if (
        !record(window) ||
        window.pid !== pid ||
        typeof window.window_id !== "number" ||
        !Number.isSafeInteger(window.window_id) ||
        window.window_id <= 0 ||
        typeof window.title !== "string"
      )
        continue;
      windows.push({ pid, windowId: window.window_id, title: window.title, app: name });
    }
  }
  return { windows, refused };
});
