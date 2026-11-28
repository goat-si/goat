// Adapted from v1 versionProbe.ts:24-180 and driver.ts:175-230, commit 916b5ccc1b2.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ProbedOpenCode { readonly generation: "v1" | "v2"; readonly version: string }
const run = promisify(execFile);

function probed(version: string): ProbedOpenCode | undefined {
  // v1 shared/semver.ts normalizes missing segments and rejects numeric prerelease leading zeroes.
  const trimmed = version.trim().replace(/^v/, "");
  const suffixAt = trimmed.search(/[-+]/);
  const main = (suffixAt < 0 ? trimmed : trimmed.slice(0, suffixAt)).split(".").map((x) => x.trim()).filter(Boolean);
  while (main.length > 0 && main.length < 3) main.push("0");
  const normalized = main.join(".") + (suffixAt < 0 ? "" : trimmed.slice(suffixAt));
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(normalized);
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) return undefined;
  const numbers = match.slice(1, 4).map(Number);
  if (!numbers.every(Number.isSafeInteger)) return undefined;
  return { generation: numbers[0]! >= 2 ? "v2" : "v1", version };
}

export function classifyOpenCodeCliVersion(output: string): ProbedOpenCode | undefined {
  // v1 provider-core/snapshotProbe.ts:222-228.
  const version = output.match(/(?<![0-9A-Za-z_.+-])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![0-9A-Za-z_+-]|\.[0-9A-Za-z])/)?.[1];
  return version === undefined ? undefined : probed(version);
}

export function classifyOpenCodeProbeResponse(path: "/api/info" | "/global/health", response: { status: number; contentType: string | null; body: string }): ProbedOpenCode | "unauthorized" | undefined {
  if (response.status === 401) return "unauthorized";
  if (response.status !== 200 || response.contentType?.split(";")[0]?.trim().toLowerCase() !== "application/json") return undefined;
  try {
    const value: unknown = JSON.parse(response.body);
    if (typeof value !== "object" || value === null) return undefined;
    const data = value as Record<string, unknown>;
    if (typeof data.version !== "string" || (path === "/api/info" ? !Number.isInteger(data.pid) : data.healthy !== true)) return undefined;
    return probed(data.version);
  } catch { return undefined; }
}

export async function selectOpenCodeRuntime(options: { binary?: string; args?: ReadonlyArray<string>; cwd?: string; environment?: NodeJS.ProcessEnv; serverUrl?: string; serverPassword?: string }): Promise<ProbedOpenCode> {
  if (!options.serverUrl?.trim()) {
    try {
      const result = await run(options.binary ?? "opencode", [...(options.args ?? []), "--version"], { cwd: options.cwd, env: options.environment, timeout: 10_000, maxBuffer: 64 * 1024 });
      const found = classifyOpenCodeCliVersion(result.stdout);
      if (found) return found;
    } catch { /* Fixed message avoids leaking launch environment or command output. */ }
    throw new Error("Unable to determine OpenCode version from `opencode --version` output.");
  }
  const base = URL.parse(options.serverUrl.trim());
  if (!base || !["http:", "https:"].includes(base.protocol)) throw new Error("The OpenCode server URL is not a valid http:// or https:// URL.");
  const headers: Record<string, string> = {};
  if (options.serverPassword) headers.authorization = `Basic ${Buffer.from(`opencode:${options.serverPassword}`, "utf8").toString("base64")}`;
  for (const path of ["/api/info", "/global/health"] as const) {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    let response: Response;
    try { response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) }); }
    catch { throw new Error("Couldn't reach the OpenCode server."); }
    const result = classifyOpenCodeProbeResponse(path, { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() });
    if (result === "unauthorized") throw new Error("401 Unauthorized: the OpenCode server rejected the password.");
    if (result) return result;
  }
  throw new Error("The server did not identify itself as OpenCode.");
}
