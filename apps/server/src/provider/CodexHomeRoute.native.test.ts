// @effect-diagnostics nodeBuiltinImport:off - drives a real Codex executable and a local Responses fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { codexHomeRouteArgv, mergeCodexHomeThreadParams } from "./CodexHomeRouteConfig.ts";
import { codexExecLaunchArgs } from "./codexLaunchArgs.ts";
import * as HomeRoute from "./OpenCodexRoute.ts";

// Opt-in native proof. Set GOAT_TEST_CODEX_NATIVE_BINARY to the pinned Codex executable whose
// archive digest matches CodexInstallation's release table; every home and endpoint is local.
const BINARY = process.env.GOAT_TEST_CODEX_NATIVE_BINARY ?? "";
const decodeSettings = Schema.decodeSync(CodexSettings);
const HYGIENE = ["-c", "features.shell_tool=false", "-c", "features.unified_exec=false"];

type Seen = { readonly path: string; readonly auth: boolean };
const sse = (model: string) => {
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: '{"ok":true}',
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
    .map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n")
    .join("");
};

/** An isolated root, a Responses fixture on loopback and the binary's bundled catalog. */
const world = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-native-home-"));
    const seen: Array<Seen> = [];
    const server = NodeHttp.createServer(async (request, response) => {
      const parts: Array<Buffer> = [];
      for await (const part of request) parts.push(part as Buffer);
      const raw = Buffer.concat(parts).toString("utf8");
      // Codex probes the endpoint with a bodyless GET before streaming.
      if (!raw) return void response.writeHead(404).end();
      seen.push({ path: request.url ?? "", auth: request.headers.authorization !== undefined });
      if (request.url !== "/v1/responses") return void response.writeHead(500).end();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(sse(JSON.parse(raw).model));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Fixture has no port");
    const base = "http://127.0.0.1:" + address.port + "/v1";
    const catalogHome = NodePath.join(root, "catalog-home");
    await NodeFS.mkdir(catalogHome);
    const catalogJson = NodeChildProcess.execFileSync(BINARY, ["debug", "models", "--bundled"], {
      env: { PATH: process.env.PATH, HOME: catalogHome, CODEX_HOME: catalogHome },
      encoding: "utf8",
    });
    const catalog = NodePath.join(root, "opencodex-catalog.json");
    await NodeFS.writeFile(catalog, catalogJson);
    const model: string = JSON.parse(catalogJson).models[0].slug;
    return { root, seen, server, base, forbidden: base + "/forbidden", catalog, model };
  }),
  ({ root, server }) =>
    Effect.promise(async () => {
      await new Promise((resolve) => server.close(resolve));
      await NodeFS.rm(root, { recursive: true, force: true });
    }),
);
type World = Effect.Success<typeof world>;

const isolatedHome = async (fixture: World, name: string) => {
  const home = NodePath.join(fixture.root, name);
  const cwd = NodePath.join(home, "project");
  await NodeFS.mkdir(cwd, { recursive: true });
  // Hostile layers: the user root and a selectable profile both point at the forbidden endpoint.
  const hostile =
    'model_provider="openai"\nopenai_base_url=' + JSON.stringify(fixture.forbidden) + "\n";
  await NodeFS.writeFile(NodePath.join(home, "config.toml"), hostile);
  await NodeFS.writeFile(NodePath.join(home, "hostile.config.toml"), hostile);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: fixture.forbidden,
  };
  return { home, cwd, env };
};

const appServer = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
  const child = NodeChildProcess.spawn(BINARY, ["app-server", ...args], { env });
  let stderr = "";
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  let sequence = 0;
  let completion: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.once("exit", () => {
    const error = new Error("Codex exited: " + stderr);
    for (const next of pending.values()) next.reject(error);
    completion?.reject(error);
  });
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    const next = pending.get(frame.id);
    if (next !== undefined) {
      pending.delete(frame.id);
      if (frame.error) next.reject(new Error(JSON.stringify(frame.error)));
      else next.resolve(frame.result);
    } else if (frame.method === "turn/completed") {
      const done = completion;
      completion = undefined;
      if (frame.params.turn.status === "completed") done?.resolve();
      else done?.reject(new Error(JSON.stringify(frame.params.turn.error)));
    } else if (frame.method !== undefined && frame.id !== undefined) {
      child.stdin.write(
        JSON.stringify({ id: frame.id, error: { code: -32601, message: "No tools" } }) + "\n",
      );
    }
  });
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  return {
    rpc,
    initialize: async () => {
      await rpc("initialize", {
        clientInfo: { name: "goat-native-home-proof", version: "1" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    },
    turn: async (threadId: string) => {
      const done = new Promise<void>((resolve, reject) => {
        completion = { resolve, reject };
      });
      await rpc("turn/start", {
        threadId,
        input: [{ type: "text", text: "Reply", text_elements: [] }],
      });
      await done;
    },
    close: async () => {
      child.kill();
      await exited;
    },
  };
};

const homeNone = (base: string) =>
  decodeSettings({
    setupMode: "managed",
    modelRoute: "opencodex",
    opencodexAuth: "none",
    opencodexBaseUrl: base,
  });
/** GOAT's own verifier over the native effective configuration. */
const verify = (
  settings: CodexSettings,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  config: unknown,
  catalog: string,
) =>
  HomeRoute.resolveCodexRouteContext({
    settings,
    binaryPath: BINARY,
    home,
    cwd,
    environment: env,
    configArgv: [],
  }).pipe(
    Effect.flatMap((input) => HomeRoute.verifyEffectiveCodexRoute(input, config, catalog)),
    Effect.result,
  );
const fixtureProvider = (base: string) =>
  '{name="Fixture",base_url=' +
  JSON.stringify(base) +
  ',wire_api="responses",requires_openai_auth=false}';

describe.skipIf(BINARY === "")("pinned native Codex through OpenCodex Home with None", () => {
  it.live.each(["openai", "openai_token_sharing", "opencodex"])(
    "continues and forks %s history through Home with GOAT's argv and thread parameters",
    (source) =>
      Effect.gen(function* () {
        const fixture = yield* world;
        const { home, cwd, env } = yield* Effect.promise(() => isolatedHome(fixture, source));
        const settings = homeNone(fixture.base);
        const threadId = yield* Effect.promise(async () => {
          const initial = appServer(
            [
              ...HYGIENE,
              "-c",
              "model_catalog_json=" + JSON.stringify(fixture.catalog),
              "-c",
              "model_provider=" + JSON.stringify(source),
              "-c",
              "openai_base_url=" + JSON.stringify(fixture.base),
              "-c",
              "model_providers.openai_token_sharing=" + fixtureProvider(fixture.base),
              "-c",
              "model_providers.opencodex=" + fixtureProvider(fixture.base),
            ],
            { ...env, OPENAI_API_KEY: "fixture-only" },
          );
          try {
            await initial.initialize();
            const started = await initial.rpc("thread/start", {
              cwd,
              model: fixture.model,
              modelProvider: source,
              approvalPolicy: "never",
              sandbox: "read-only",
            });
            await initial.turn(started.thread.id);
            return started.thread.id as string;
          } finally {
            await initial.close();
          }
        });
        const first = fixture.seen.length;
        const routed = appServer(
          [...HYGIENE, ...codexHomeRouteArgv(settings, fixture.base, fixture.catalog)],
          env,
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => routed.close()));
        yield* Effect.promise(() => routed.initialize());
        const { config } = yield* Effect.promise(() =>
          routed.rpc("config/read", { cwd, includeLayers: false }),
        );
        assert.equal(
          (yield* verify(settings, home, cwd, env, config, fixture.catalog))._tag,
          "Success",
        );
        const params = mergeCodexHomeThreadParams(settings, { config: {} });
        const resumed = yield* Effect.promise(() =>
          routed.rpc("thread/resume", { threadId, excludeTurns: true, ...params }),
        );
        assert.equal(resumed.thread.id, threadId);
        assert.equal(resumed.modelProvider, "opencodex");
        yield* Effect.promise(() => routed.turn(threadId));
        const forked = yield* Effect.promise(() =>
          routed.rpc("thread/fork", { threadId, ...params }),
        );
        assert.notEqual(forked.thread.id, threadId);
        assert.equal(forked.modelProvider, "opencodex");
        yield* Effect.promise(() => routed.turn(forked.thread.id));
        const routedRequests = fixture.seen.slice(first);
        assert.isAtLeast(routedRequests.length, 2);
        assert.deepStrictEqual(
          routedRequests.filter((row) => row.path !== "/v1/responses" || row.auth),
          [],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([false, true])(
    "runs exec through Home with None past a hostile profile (isolated reception: %s)",
    (reception) =>
      Effect.gen(function* () {
        const fixture = yield* world;
        const { home, env } = yield* Effect.promise(() => isolatedHome(fixture, "exec"));
        const settings = homeNone(fixture.base);
        const routeArgs = codexHomeRouteArgv(settings, fixture.base, fixture.catalog);
        const execHome = NodePath.join(home, "reception");
        const output = NodePath.join(home, "output.json");
        const schema = NodePath.join(home, "schema.json");
        const exit = yield* Effect.promise(async () => {
          await NodeFS.mkdir(execHome, { recursive: true });
          await NodeFS.writeFile(
            schema,
            JSON.stringify({
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            }),
          );
          const args = reception
            ? ["--ignore-user-config", ...routeArgs]
            : codexExecLaunchArgs("--profile hostile", routeArgs);
          const child = NodeChildProcess.spawn(
            BINARY,
            [
              "exec",
              ...args,
              ...HYGIENE,
              "--ephemeral",
              "--skip-git-repo-check",
              "-s",
              "read-only",
              "--model",
              fixture.model,
              "--output-schema",
              schema,
              "--output-last-message",
              output,
              "-",
            ],
            { env: { ...env, CODEX_HOME: reception ? execHome : home } },
          );
          let stderr = "";
          child.stderr.on("data", (part) => {
            stderr += part;
          });
          child.stdout.resume();
          const code = new Promise((resolve) => child.once("exit", resolve));
          child.stdin.end("Reply");
          return { code: await code, stderr };
        });
        assert.equal(exit.code, 0, exit.stderr);
        assert.deepStrictEqual(
          JSON.parse(yield* Effect.promise(() => NodeFS.readFile(output, "utf8"))),
          { ok: true },
        );
        assert.isAtLeast(fixture.seen.length, 1);
        assert.deepStrictEqual(
          fixture.seen.filter((row) => row.path !== "/v1/responses" || row.auth),
          [],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "rejects a user bearer token that survives GOAT's Home None override before any inference",
    () =>
      Effect.gen(function* () {
        const fixture = yield* world;
        const { home, cwd, env } = yield* Effect.promise(() => isolatedHome(fixture, "credential"));
        // Codex merges GOAT's -c table into the user's table, so these keys stay effective.
        yield* Effect.promise(() =>
          NodeFS.appendFile(
            NodePath.join(home, "config.toml"),
            '[model_providers.opencodex]\nname = "User"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nexperimental_bearer_token = "synthetic-user-token"\nhttp_headers = { "X-User" = "synthetic" }\n',
          ),
        );
        const settings = homeNone(fixture.base);
        const routed = appServer(
          [...HYGIENE, ...codexHomeRouteArgv(settings, fixture.base, fixture.catalog)],
          env,
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => routed.close()));
        yield* Effect.promise(() => routed.initialize());
        const { config } = yield* Effect.promise(() =>
          routed.rpc("config/read", { cwd, includeLayers: false }),
        );
        assert.equal(
          config.model_providers.opencodex.experimental_bearer_token,
          "synthetic-user-token",
        );
        assert.equal(
          (yield* verify(settings, home, cwd, env, config, fixture.catalog))._tag,
          "Failure",
        );
        assert.deepStrictEqual(fixture.seen, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
