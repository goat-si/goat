// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - a plain Node script an agent runs against a live server; no Effect runtime.
/**
 * Live smoke test of the agent surface against a running GOAT server.
 *
 *   GOAT_SMOKE_ENDPOINT=http://127.0.0.1:3773/mcp GOAT_SMOKE_AUTHORIZATION="Bearer ..." \
 *     node scripts/agent-surface/smoke.ts [--json]
 *
 * Without GOAT_SMOKE_*, it uses GOAT_ACP_MCP_ENDPOINT and GOAT_ACP_MCP_AUTHORIZATION, which GOAT
 * sets for ACP agents, so a thread's own credential is what gets tested. It only lists tools and
 * calls reads; it never starts work, creates handoffs, or changes settings.
 *
 * Checks the listing against packages/contracts/src/agentSurface/registry.ts, the published
 * annotations and closed schemas, refusal of unknown arguments, and that every safe read answers
 * with a result or a coded error. When the server offers goat_call, goat_eval or goat_describe
 * (docs/internals/agent-surface.md#rollout, steps 5 and 11) it also checks that a call through them
 * matches the direct call and that goat_eval enforces its call cap. Exit 0 when nothing failed.
 */
type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };
interface RegistryEntry {
  readonly path: string;
  readonly name: string;
  readonly legacyNames: ReadonlyArray<string>;
  readonly effect: "read" | "write" | "destructive";
}
interface ListedTool {
  readonly name: string;
  readonly inputSchema?: JsonObject;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
}
interface CallResult {
  readonly isError?: boolean;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: Json;
}
type Status = "pass" | "fail" | "pending";
interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail?: string;
}

const endpoint = process.env.GOAT_SMOKE_ENDPOINT ?? process.env.GOAT_ACP_MCP_ENDPOINT;
const authorization =
  process.env.GOAT_SMOKE_AUTHORIZATION ?? process.env.GOAT_ACP_MCP_AUTHORIZATION;
const asJson = process.argv.includes("--json");
// Loaded at run time: the scripts project does not compile the contracts package.
const registryModule = (await import(
  new URL("../../packages/contracts/src/agentSurface/registry.ts", import.meta.url).href
)) as { readonly agentSurfaceRegistry: Readonly<Record<string, RegistryEntry>> };
const entries = Object.values(registryModule.agentSurfaceRegistry);
const byName = new Map<string, RegistryEntry>(
  entries.flatMap((entry) =>
    [entry.name, ...entry.legacyNames].map((name) => [name, entry] as const),
  ),
);

// Side-effect-free calls every caller may make; each answers with a result or a coded error.
const SAFE_READS: ReadonlyArray<readonly [string, JsonObject]> = [
  ["goat_environment_read", {}],
  ["goat_permission_profile_get", {}],
  ["goat_project_list", {}],
  ["goat_thread_list", { limit: 1 }],
  ["goat_host_status", { local: true }],
  ["goat_decision_list", {}],
];

let sessionId: string | null = null;
let protocolVersion: string | null = null;
let nextId = 1;

const parseBody = async (response: Response): Promise<ReadonlyArray<JsonObject>> => {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream"))
    return text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as JsonObject);
  return text.trim() === "" ? [] : [JSON.parse(text) as JsonObject];
};

const post = async (method: string, params: JsonObject, id: number | undefined) => {
  const response = await fetch(endpoint!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: authorization!,
      ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) }),
  });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  return parseBody(response);
};
const notify = async (method: string, params: JsonObject) => {
  await post(method, params, undefined);
};
const rpc = async (method: string, params: JsonObject): Promise<JsonObject> => {
  const id = nextId++;
  const message = (await post(method, params, id)).find((payload) => payload["id"] === id);
  if (message === undefined) throw new Error(`${method}: no response`);
  if (message["error"] !== undefined)
    throw new Error(`${method}: ${JSON.stringify(message["error"])}`);
  return message["result"] as JsonObject;
};

const callTool = async (name: string, args: JsonObject): Promise<CallResult> =>
  (await rpc("tools/call", { name, arguments: args })) as CallResult;

const resultText = (result: CallResult) =>
  result.content?.find((item) => item.type === "text")?.text ?? "";
const errorCode = (result: CallResult): string | undefined => {
  try {
    const parsed = JSON.parse(resultText(result)) as JsonObject;
    return typeof parsed["code"] === "string" ? parsed["code"] : undefined;
  } catch {
    return undefined;
  }
};
/** What a caller can rely on: success, or the refusal code. */
const outcome = (result: CallResult) =>
  result.isError ? `error:${errorCode(result) ?? "uncoded"}` : "ok";

const main = async (): Promise<ReadonlyArray<Check>> => {
  const checks: Array<Check> = [];
  const check = (name: string, failures: ReadonlyArray<string>, pendingReason?: string) =>
    checks.push(
      pendingReason !== undefined
        ? { name, status: "pending", detail: pendingReason }
        : failures.length === 0
          ? { name, status: "pass" }
          : { name, status: "fail", detail: failures.join("; ") },
    );

  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "goat-agent-surface-smoke", version: "1" },
  });
  protocolVersion =
    typeof initialized["protocolVersion"] === "string" ? initialized["protocolVersion"] : null;
  await notify("notifications/initialized", {});

  const listed: Array<ListedTool> = [];
  let cursor: string | undefined;
  do {
    const page = await rpc("tools/list", cursor === undefined ? {} : { cursor });
    listed.push(...((page["tools"] ?? []) as unknown as ReadonlyArray<ListedTool>));
    cursor = typeof page["nextCursor"] === "string" ? page["nextCursor"] : undefined;
  } while (cursor !== undefined);
  const listedNames = new Set(listed.map((tool) => tool.name));
  const META = new Set(["goat_describe", "goat_call", "goat_eval"]);

  check(
    "every listed tool has a registry entry",
    listed
      .filter((tool) => !byName.has(tool.name) && !META.has(tool.name))
      .map((tool) => tool.name),
  );
  check(
    "annotations match each entry's effect",
    listed.flatMap((tool) => {
      const entry = byName.get(tool.name);
      if (entry === undefined) return [];
      const readOnly = tool.annotations?.readOnlyHint === true;
      const destructive = tool.annotations?.destructiveHint === true;
      return readOnly === (entry.effect === "read") &&
        destructive === (entry.effect === "destructive")
        ? []
        : [
            `${tool.name} is ${entry.effect}, published readOnly=${readOnly} destructive=${destructive}`,
          ];
    }),
  );
  check(
    "input schemas are closed objects",
    listed
      .filter(
        (tool) =>
          tool.inputSchema?.["type"] !== "object" ||
          tool.inputSchema["additionalProperties"] !== false,
      )
      .map((tool) => tool.name),
  );

  const probe = SAFE_READS.find(([name]) => listedNames.has(name));
  if (probe === undefined)
    check("unknown arguments are refused before the handler", [], "no safe read is listed");
  else {
    const refused = await callTool(probe[0], { ...probe[1], misspelledHost: "box" });
    check(
      "unknown arguments are refused before the handler",
      refused.isError === true && errorCode(refused) === "invalid_request"
        ? []
        : [`${probe[0]} answered ${outcome(refused)}`],
    );
  }

  const direct = new Map<string, string>();
  const readFailures: Array<string> = [];
  for (const [name, args] of SAFE_READS) {
    if (!listedNames.has(name)) continue;
    const result = await callTool(name, args);
    direct.set(name, outcome(result));
    if (result.isError === true && errorCode(result) === undefined)
      readFailures.push(`${name} failed without a code: ${resultText(result).slice(0, 120)}`);
  }
  check("safe reads answer with a result or a coded error", readFailures);

  if (!listedNames.has("goat_call"))
    check("goat_call matches direct calls", [], "goat_call is not offered (rollout step 5)");
  else {
    const failures: Array<string> = [];
    for (const [name, args] of SAFE_READS) {
      const entry = byName.get(name);
      if (entry === undefined || !direct.has(name)) continue;
      const result = await callTool("goat_call", { path: entry.path, args });
      const envelope = result.structuredContent as JsonObject | undefined;
      const status = envelope?.["status"];
      if (status !== "ok" && status !== "error" && status !== "needs_human")
        failures.push(`${entry.path}: no envelope status`);
      const viaCall =
        status === "ok"
          ? "ok"
          : `error:${String((envelope?.["error"] as JsonObject | undefined)?.["reason"] ?? "")}`;
      if (viaCall !== direct.get(name))
        failures.push(`${entry.path}: direct ${direct.get(name)}, goat_call ${viaCall}`);
    }
    check("goat_call matches direct calls", failures);
  }

  if (!listedNames.has("goat_eval"))
    check(
      "goat_eval enforces its call cap",
      [],
      "goat_eval is not offered (rollout step 11, gated)",
    );
  else {
    const call = { call: "environment.read", args: {} };
    const tooMany = { seq: Array.from({ length: 33 }, () => call) };
    const [first, second] = [
      await callTool("goat_eval", { program: tooMany }),
      await callTool("goat_eval", { program: tooMany }),
    ];
    const failures: Array<string> = [];
    if (
      first.isError !== true &&
      (first.structuredContent as JsonObject | undefined)?.["status"] !== "error"
    )
      failures.push("33 calls were accepted");
    if (resultText(first) !== resultText(second))
      failures.push("the same over-limit program failed differently");
    check("goat_eval enforces its call cap", failures);
  }

  if (!listedNames.has("goat_describe"))
    check(
      "goat_describe covers every listed tool",
      [],
      "goat_describe is not offered (rollout step 5)",
    );
  else {
    const failures: Array<string> = [];
    for (const tool of listed) {
      const entry = byName.get(tool.name);
      if (entry === undefined) continue;
      const described = await callTool("goat_describe", { path: entry.path });
      if (described.isError === true) failures.push(`${entry.path}: ${outcome(described)}`);
    }
    check("goat_describe covers every listed tool", failures);
  }
  return checks;
};

if (endpoint === undefined || authorization === undefined) {
  process.stderr.write(
    "Set GOAT_SMOKE_ENDPOINT and GOAT_SMOKE_AUTHORIZATION (or run inside a GOAT ACP agent).\n",
  );
  process.exitCode = 2;
} else {
  const checks = await main();
  if (asJson) process.stdout.write(JSON.stringify({ endpoint, checks }, null, 2) + "\n");
  else
    for (const { name, status, detail } of checks)
      process.stdout.write(
        `${status.padEnd(7)} ${name}${detail === undefined ? "" : ` — ${detail}`}\n`,
      );
  if (checks.some((entry) => entry.status === "fail")) process.exitCode = 1;
}
