// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - CI opens the shipped app against an isolated home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication } from "playwright-core";
import {
  assertDesktopLaunchMigrated,
  LAUNCH_THREAD_MESSAGE,
  LAUNCH_THREAD_TITLE,
  prepareDesktopLaunchHome,
} from "./lib/desktop-launch-fixture.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    "artifacts-dir": { type: "string" },
  },
});
if (!values.executable) {
  throw new Error("Usage: smoke-desktop-app.ts --executable <app> [--artifacts-dir <dir>]");
}
const artifacts = NodePath.resolve(values["artifacts-dir"] ?? "desktop-launch-check");
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-desktop-launch-"));
let step = "preparing the fixture";
let app: ElectronApplication | undefined;
try {
  const { home, dbPath } = prepareDesktopLaunchHome(scratch);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) =>
        value !== undefined && key !== "ELECTRON_RUN_AS_NODE" && key !== "NODE_OPTIONS"
          ? [[key, value] as const]
          : [],
      ),
    ),
    HOME: scratch,
    USERPROFILE: scratch,
    APPDATA: NodePath.join(scratch, "AppData/Roaming"),
    LOCALAPPDATA: NodePath.join(scratch, "AppData/Local"),
    GOAT_HOME: home,
    GOAT_DISABLE_AUTO_UPDATE: "true",
    GOAT_TELEMETRY_ENABLED: "false",
    VITE_DEV_SERVER_URL: "",
    GOAT_DEV_REMOTE_SERVER_ENTRY_PATH: "",
    XDG_CONFIG_HOME: NodePath.join(scratch, ".config"),
    XDG_DATA_HOME: NodePath.join(scratch, ".local/share"),
  };
  step = "launching the app";
  app = await _electron.launch({
    executablePath: values.executable,
    cwd: scratch,
    args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    env,
    timeout: 60_000,
  });
  step = "waiting for the first window";
  const page = await app.firstWindow({ timeout: 60_000 });
  try {
    step = "finding the seeded thread";
    const thread = page.locator("li[data-thread-item]", { hasText: LAUNCH_THREAD_TITLE });
    await thread.waitFor({ timeout: 60_000 });
    step = "opening the seeded thread";
    await thread.click();
    await page.getByText(LAUNCH_THREAD_MESSAGE, { exact: true }).waitFor({ timeout: 60_000 });
    step = "checking the migrated database";
    const migrations = assertDesktopLaunchMigrated(dbPath);
    NodeFS.mkdirSync(artifacts, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(artifacts, "migrations.json"),
      JSON.stringify(migrations, null, 2),
    );
  } catch (error) {
    NodeFS.mkdirSync(artifacts, { recursive: true });
    await page
      .screenshot({ path: NodePath.join(artifacts, "window.png"), timeout: 10_000 })
      .catch((captureError: unknown) => {
        console.error("Could not capture the failed window:", captureError);
      });
    throw error;
  }
  console.log(
    "Desktop launch check passed: GOAT migrated the fixture and showed its seeded thread.",
  );
} catch (error) {
  console.error(`Desktop launch check failed while ${step}.`, error);
  NodeFS.mkdirSync(artifacts, { recursive: true });
  const logs = NodePath.join(scratch, "goat/userdata/logs");
  if (NodeFS.existsSync(logs))
    NodeFS.cpSync(logs, NodePath.join(artifacts, "logs"), { recursive: true });
  process.exitCode = 1;
} finally {
  if (app) {
    const child = app.process();
    const closed = app
      .close()
      .catch((error: unknown) => console.error("Could not close GOAT:", error));
    await Promise.race([closed, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  NodeFS.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
