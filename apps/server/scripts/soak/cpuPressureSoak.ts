// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type SoakOptions = {
  home: string;
  report: string;
  serverPort: number;
  projectId?: string;
  replayThreads: number;
  headlessClients: number;
  codexThreads: number;
  durationMs: number;
};

export function parseArgs(argv: string[]): SoakOptions {
  const values = new Map<string, string>();
  const known = new Set([
    "home",
    "report",
    "server-port",
    "project-id",
    "replay-threads",
    "headless-clients",
    "codex-threads",
    "duration-ms",
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (
      !key?.startsWith("--") ||
      !known.has(key.slice(2)) ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(key.slice(2))
    )
      throw new Error(`invalid argument: ${key ?? ""}`);
    values.set(key.slice(2), value);
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`missing --${key}`);
    return value;
  };
  const integer = (key: string, defaultValue: number, min: number, max: number) => {
    const raw = values.get(key) ?? String(defaultValue);
    if (!/^\d+$/.test(raw)) throw new Error(`invalid --${key}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`invalid --${key}`);
    return value;
  };
  const port = required("server-port");
  const home = required("home");
  const report = required("report");
  if (!NodePath.isAbsolute(home) || !NodePath.isAbsolute(report))
    throw new Error("home and report must be absolute");
  return {
    home,
    report,
    serverPort: integer("server-port", Number(port), 1, 65535),
    ...(values.has("project-id") ? { projectId: required("project-id") } : {}),
    replayThreads: integer("replay-threads", 120, 1, 10000),
    headlessClients: integer("headless-clients", 20, 1, 1000),
    codexThreads: integer("codex-threads", 2, 1, 1000),
    durationMs: integer("duration-ms", 1800000, 1, 86400000),
  };
}

export function validateHome(home: string, checkout: string): string {
  const root = NodeFS.realpathSync(checkout);
  const supplied = NodePath.resolve(home);
  if (supplied !== NodePath.join(root, ".goat") && supplied !== NodePath.join(root, ".t3"))
    throw new Error("home must be the checkout's isolated .goat or .t3");
  if (NodeFS.realpathSync(supplied) !== supplied)
    throw new Error("home is a symlink or escapes checkout");
  const database = NodePath.join(supplied, "userdata", "statev2.sqlite");
  const realDatabase = NodeFS.realpathSync(database);
  if (
    !realDatabase.startsWith(`${supplied}${NodePath.sep}`) ||
    !NodeFS.statSync(realDatabase).isFile() ||
    NodeFS.statSync(realDatabase).size === 0
  )
    throw new Error("missing or unsafe copied database");
  return supplied;
}
