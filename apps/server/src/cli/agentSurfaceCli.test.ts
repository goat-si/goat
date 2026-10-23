import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  serveCatalogOverHttp,
  serveEnforcingCatalogOverHttp,
} from "../mcp/agentSurface.testkit.ts";
import type { McpClientCaller, McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { runAgentSurfaceInvocation } from "./agentSurfaceCli.ts";
import { agentSurfaceInvocation, exitCodeOf, type InputReader } from "./agentSurfaceCommand.ts";

const entries = Object.values(agentSurfaceRegistry) as ReadonlyArray<AgentSurfaceRegistryEntry>;
const CALLER_THREAD = ThreadId.make("thread:cli-caller");

const scope = (
  caller: { readonly thread: true } | { readonly client: McpClientCaller["access"] },
): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "thread" in caller ? `provider:${CALLER_THREAD}` : "client:session",
  thread:
    "thread" in caller
      ? {
          threadId: CALLER_THREAD,
          providerSessionId: `provider:${CALLER_THREAD}`,
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
  client:
    "thread" in caller ? undefined : { sessionId: "session", label: "CLI", access: caller.client },
  capabilities: new Set([
    "memory",
    "preview",
    "orchestration",
    "worktree",
    "device",
    "pull-requests",
  ]),
  issuedAt: 0,
});
const callers = {
  thread: scope({ thread: true }),
  outside: scope({ client: "full-access" }),
  readOnly: scope({ client: "read-only" }),
};
type Caller = keyof typeof callers;

const noInput: InputReader = {
  stdin: () => "{}",
  file: () => {
    throw new Error("no files here");
  },
};

/** Runs one goat command line as an agent shell holding `caller`'s credential would. */
const runCli = (
  argv: ReadonlyArray<string>,
  credential: { readonly endpoint: string; readonly authorization: string },
  fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>,
) =>
  Effect.gen(function* () {
    const invocation = agentSurfaceInvocation(argv, noInput);
    if (invocation === undefined)
      return yield* Effect.die(`not a generated command: ${argv.join(" ")}`);
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const code = yield* runAgentSurfaceInvocation(invocation, {
      env: {
        GOAT_ACP_MCP_ENDPOINT: credential.endpoint,
        GOAT_ACP_MCP_AUTHORIZATION: credential.authorization,
      },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      loadLogin: Effect.die("a shell with a thread credential never reads a login"),
      ...(fetchImplementation === undefined ? {} : { fetchImplementation }),
    });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  });

const envelopeOf = (stdout: string) => JSON.parse(stdout) as AgentSurfaceResult;

/** goat call and goat_call for the same caller and arguments: same envelope, matching exit code. */
const expectParity = Effect.fn(function* (
  http: Effect.Success<ReturnType<typeof serveCatalogOverHttp>>,
  caller: Caller,
  argv: ReadonlyArray<string>,
  path: string,
  args: Record<string, unknown>,
) {
  const direct = yield* http.callTool(caller, "goat_call", { path, args });
  const envelope = direct.structuredContent as AgentSurfaceResult;
  const cli = yield* runCli([...argv, "--json"], {
    endpoint: http.endpoint,
    authorization: `Bearer ${caller}.token`,
  });
  expect(envelopeOf(cli.stdout), `${caller}: ${argv.join(" ")}`).toEqual(envelope);
  expect(cli.code, `${caller}: ${argv.join(" ")}`).toBe(exitCodeOf(envelope));
  return envelope;
});

describe("goat call through the origin's /mcp", () => {
  it.effect("returns exactly what goat_call returns for the same caller", () =>
    Effect.gen(function* () {
      const http = yield* serveCatalogOverHttp(callers);
      const clientOnly = entries.find((entry) => entry.requires === "client")!;
      const threadOnly = entries.find((entry) => entry.requires === "thread")!;
      const write = entries.find(
        (entry) => entry.effect !== "read" && entry.requires === "either",
      )!;
      const cases: ReadonlyArray<
        readonly [ReadonlyArray<string>, string, Record<string, unknown>]
      > = [
        [["describe"], "surface.describe", {}],
        [["describe", "thread.send"], "surface.describe", { path: "thread.send" }],
        [["describe", "--query", "send message"], "surface.describe", { query: "send message" }],
        [["call", "thread.teleport"], "thread.teleport", {}],
        [
          ["call", "surface.call", '{"path":"surface.describe"}'],
          "surface.call",
          { path: "surface.describe" },
        ],
        [
          ["call", "thread.read", '{"misspelledHost":"box"}'],
          "thread.read",
          { misspelledHost: "box" },
        ],
        [["thread", "read", "-f", "misspelledHost=box"], "thread.read", { misspelledHost: "box" }],
        [
          ["acp-mcp-call", "goat_thread_read", '{"misspelledHost":"box"}'],
          "goat_thread_read",
          { misspelledHost: "box" },
        ],
        [["call", clientOnly.path], clientOnly.path, {}],
        [["call", threadOnly.path], threadOnly.path, {}],
        [["call", write.path, "-F", "misspelled=1"], write.path, { misspelled: 1 }],
      ];
      for (const caller of Object.keys(callers) as ReadonlyArray<Caller>)
        for (const [argv, path, args] of cases) yield* expectParity(http, caller, argv, path, args);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("searches paths by query, within a resource when one is named", () =>
    Effect.gen(function* () {
      const http = yield* serveCatalogOverHttp(callers);
      const credential = { endpoint: http.endpoint, authorization: "Bearer thread.token" };
      const search = (...argv: ReadonlyArray<string>) =>
        runCli(["describe", ...argv, "--json"], credential).pipe(
          Effect.map((cli) => envelopeOf(cli.stdout)),
        );
      const found = yield* search("--query", "send message");
      expect(found).toMatchObject({ status: "ok", value: { depth: "search", truncated: false } });
      const paths = (
        found as { value: { entries: ReadonlyArray<{ path: string }> } }
      ).value.entries.map((entry) => entry.path);
      expect(paths).toContain("thread.send");
      const narrowed = yield* search("preview", "--query", "click");
      expect(
        (narrowed as { value: { entries: ReadonlyArray<{ path: string }> } }).value.entries.every(
          (entry) => entry.path.startsWith("preview."),
        ),
      ).toBe(true);
      // A broad word returns the cap and says more match, instead of claiming that is all.
      expect(yield* search("--query", "a")).toMatchObject({ value: { truncated: true } });
      expect(yield* search("thread.send", "--query", "send")).toMatchObject({
        status: "error",
        error: { code: "invalid_request" },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "keeps the goatclaw refusals a direct call gets, host allowlist and threads.remote included",
    () =>
      Effect.gen(function* () {
        yield* SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) => sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${CALLER_THREAD}, 'project', 'Test', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`,
          ),
        );
        const settings = yield* ServerSettings.ServerSettingsService;
        const policy = (yield* settings.getSettings).goatclaw;
        yield* settings.updateSettings({
          goatclaw: {
            ...policy,
            profiles: {
              ...policy.profiles,
              manager: { ...policy.profiles.manager!, hosts: ["box"] },
            },
          },
        });
        const http = yield* serveEnforcingCatalogOverHttp(callers);
        const send = { threadId: "thread:target", message: "hi" };
        const sendArgv = ["thread", "send-attachments"];
        void sendArgv;
        // thread send is an operator verb, so the generic route carries this path.
        const offList = yield* expectParity(
          http,
          "thread",
          ["call", "thread.send", JSON.stringify(send), "--host", "other"],
          "thread.send",
          { ...send, host: "other" },
        );
        expect(offList).toMatchObject({ status: "error", error: { code: "permission_denied" } });
        expect(JSON.stringify(offList)).toContain("host other");

        yield* settings.updateSettings({ goatclaw: { ...policy, defaultProfile: "worker" } });
        const noRemote = yield* expectParity(
          http,
          "thread",
          [
            "call",
            "thread.send",
            "-f",
            "threadId=thread:target",
            "-f",
            "message=hi",
            "--host",
            "box",
          ],
          "thread.send",
          { ...send, host: "box" },
        );
        expect(JSON.stringify(noRemote)).toContain("threads.remote");

        const settingsWrite = yield* expectParity(
          http,
          "thread",
          ["environment", "preferences-update"],
          "environment.preferences_update",
          {},
        );
        expect(JSON.stringify(settingsWrite)).toContain("settings.write");

        const readOnly = yield* expectParity(
          http,
          "readOnly",
          ["call", "thread.send", JSON.stringify(send)],
          "thread.send",
          send,
        );
        expect(readOnly).toMatchObject({ status: "error" });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeHttpServer.layerTest,
            Sqlite.layerMemory,
            ServerSettings.layerTest({ goatclaw: { enabled: true, defaultProfile: "manager" } }),
          ),
        ),
      ),
  );
});

const ENDPOINT = "http://origin.test/mcp";
const AUTHORIZATION = "Bearer thread-token";

/** A minimal origin: it completes the MCP handshake and answers tools/call with `answer`. */
const fakeOrigin = (answer: (id: unknown) => Promise<Response>) => {
  const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
  const fetchImplementation = async (url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    requests.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    if (body?.method === "initialize")
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "t", version: "1" },
          },
        },
        { headers: { "mcp-session-id": "session-1" } },
      );
    if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
    return answer(body?.id);
  };
  return { requests, fetchImplementation };
};
const toolResult = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const credential = { endpoint: ENDPOINT, authorization: AUTHORIZATION };

describe("goat call's credential and routing", () => {
  it.effect(
    "sends --host to the origin as the call's host and never contacts the host itself",
    () =>
      Effect.gen(function* () {
        const origin = fakeOrigin(async (id) =>
          toolResult(id, {
            content: [],
            structuredContent: { status: "ok", value: { threadId: "t" }, meta: { host: "box" } },
          }),
        );
        const cli = yield* runCli(
          ["thread", "read", "-f", "threadId=t", "--host", "box", "--json"],
          credential,
          origin.fetchImplementation,
        );
        expect(cli.code).toBe(0);
        expect(new Set(origin.requests.map((request) => request.url))).toEqual(new Set([ENDPOINT]));
        expect(new Set(origin.requests.map((request) => request.authorization))).toEqual(
          new Set([AUTHORIZATION]),
        );
        const call = origin.requests.find(
          (request) => (request.body as { method?: unknown } | undefined)?.method === "tools/call",
        );
        expect(call?.body).toMatchObject({
          params: {
            name: "goat_call",
            arguments: { path: "thread.read", args: { threadId: "t", host: "box" } },
          },
        });
      }),
  );

  it.effect("names the operation an ok result started, so accepted work is not read as done", () =>
    Effect.gen(function* () {
      const operation = { operationId: "op-9", kind: "task", state: "running", cancellable: true };
      const origin = fakeOrigin(async (id) =>
        toolResult(id, {
          content: [],
          structuredContent: { status: "ok", value: { taskId: "t" }, meta: { operation } },
        }),
      );
      const cli = yield* runCli(["call", "task.create"], credential, origin.fetchImplementation);
      expect(cli.code).toBe(0);
      expect(cli.stderr).toContain("goat operation wait op-9");
    }),
  );

  it.effect(
    "reports a write whose answer was lost as an unknown outcome and a read as retryable",
    () =>
      Effect.gen(function* () {
        const write = entries.find((entry) => entry.effect === "write")!;
        const dropped = fakeOrigin(() => Promise.reject(new TypeError("socket hang up")));
        const lostWrite = yield* runCli(
          ["call", write.path, "--json"],
          credential,
          dropped.fetchImplementation,
        );
        expect(lostWrite.code).toBe(5);
        expect(envelopeOf(lostWrite.stdout)).toMatchObject({
          error: { code: "unknown_outcome", retryable: false },
        });
        const failing = fakeOrigin(async () => new Response("boom", { status: 500 }));
        expect(
          (yield* runCli(["call", write.path], credential, failing.fetchImplementation)).code,
        ).toBe(5);
        expect(
          (yield* runCli(["call", "thread.read"], credential, dropped.fetchImplementation)).code,
        ).toBe(4);
      }),
  );

  it.effect("fails closed on a blanked thread credential without reading the stored login", () =>
    Effect.gen(function* () {
      const invocation = agentSurfaceInvocation(["call", "thread.read", "--json"], noInput)!;
      const stdout: Array<string> = [];
      const code = yield* runAgentSurfaceInvocation(invocation, {
        env: { GOAT_ACP_MCP_ENDPOINT: "", GOAT_ACP_MCP_AUTHORIZATION: "" },
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
        loadLogin: Effect.die("a blanked thread credential must not fall back to the login"),
      });
      expect(code).toBe(1);
      expect(envelopeOf(stdout.join(""))).toMatchObject({
        error: { code: "unauthenticated", reason: "thread_credential_invalid" },
      });
    }),
  );

  it.effect("fails closed when the origin refuses the thread credential, at any step", () =>
    Effect.gen(function* () {
      // /mcp refuses an expired registry credential inside a 200 tools/call answer.
      const expired = fakeOrigin(async (id) =>
        toolResult(id, {
          isError: true,
          content: [{ type: "text", text: "This MCP credential has expired." }],
        }),
      );
      const refusedInBand = yield* runCli(
        ["call", "thread.read"],
        credential,
        expired.fetchImplementation,
      );
      expect(refusedInBand.code).toBe(1);
      expect(refusedInBand.stderr).toContain("does not fall back");
      const unauthorized = fakeOrigin(async () => new Response(null, { status: 401 }));
      const refused = yield* runCli(
        ["call", "thread.send", "--json"],
        credential,
        unauthorized.fetchImplementation,
      );
      expect(refused.code).toBe(1);
      expect(envelopeOf(refused.stdout)).toMatchObject({ error: { code: "unauthenticated" } });
    }),
  );
});
