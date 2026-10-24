// @effect-diagnostics nodeBuiltinImport:off - a plain Node script module; it drives the server's own Effect runtime from outside.
/**
 * The tools /mcp serves at the checked-out commit, built in-process from the same registrations
 * with inert services (apps/server/src/mcp/agentSurface.testkit.ts), and a way to call them as a
 * GOAT thread would. Handlers behind the inert services cannot do real work, so only calls that
 * stay in the registry (goat_describe) or stop at admission and argument checks are meaningful.
 */
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
const serverRequire = NodeModule.createRequire(NodePath.join(repoRoot, "apps/server/package.json"));
// The catalog's Layer and McpServer must come from the server's own effect instance.
const fromServer = <T>(specifier: string): Promise<T> =>
  import(NodeURL.pathToFileURL(serverRequire.resolve(specifier)).href) as Promise<T>;
const fromRepo = <T>(file: string): Promise<T> =>
  import(NodeURL.pathToFileURL(NodePath.join(repoRoot, file)).href) as Promise<T>;

export interface ListedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

export interface CallResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

export interface ServedCatalog {
  readonly tools: ReadonlyArray<ListedTool>;
  /**
   * What tools/list sends a GOAT thread under an agentToolListing value: the /mcp transport over
   * HTTP, MCP protocol 2025-06-18, with the server's own listing filter, so a measurement cannot
   * drift from what agents receive.
   */
  readonly listedAsThread: (listing: "full" | "core") => Promise<ReadonlyArray<ListedTool>>;
  /** tools/call as an agent inside a GOAT thread with every capability granted. */
  readonly callAsThread: (name: string, args: object) => Promise<CallResult>;
  readonly dispose: () => Promise<void>;
}

interface Pipeable<Self> {
  readonly pipe: (...fns: ReadonlyArray<(self: Self) => Self>) => Self;
}
type Layer = Pipeable<Layer>;
type Program = Pipeable<Program>;
interface Server {
  readonly tools: ReadonlyArray<{ readonly tool: ListedTool }>;
  readonly callTool: (request: { readonly name: string; readonly arguments: object }) => Program;
}

export async function loadServedCatalog(): Promise<ServedCatalog> {
  const Effect = await fromServer<{
    readonly flatMap: <A>(f: (a: A) => Program) => (self: Program) => Program;
    readonly map: <A, B>(f: (a: A) => B) => (self: Program) => Program;
    readonly provideService: (tag: unknown, value: unknown) => (self: Program) => Program;
    readonly provide: (layer: Layer) => (self: Program) => Program;
    readonly scoped: (self: Program) => Program;
    readonly runPromise: <A>(program: Program) => Promise<A>;
  }>("effect/Effect");
  const LayerModule = await fromServer<{
    readonly provide: (layer: Layer) => (self: Layer) => Layer;
    readonly provideMerge: (layer: Layer) => (self: Layer) => Layer;
  }>("effect/Layer");
  const ManagedRuntime = await fromServer<{
    readonly make: (layer: Layer) => {
      readonly runPromise: <A>(program: Program) => Promise<A>;
      readonly dispose: () => Promise<void>;
    };
  }>("effect/ManagedRuntime");
  const { McpServer, McpSchema } = await fromServer<{
    readonly McpServer: { readonly McpServer: Program & { readonly layer: Layer } };
    readonly McpSchema: { readonly McpServerClient: unknown };
  }>("effect/ai");
  const kit = await fromRepo<{
    readonly catalog: Layer;
    readonly dependencies: Layer;
    readonly client: unknown;
    readonly serveCatalogOverHttp: (
      scopes: Readonly<Record<string, unknown>>,
      listing: string,
    ) => Program;
  }>("apps/server/src/mcp/agentSurface.testkit.ts");
  const { McpInvocationContext } = await fromRepo<{ readonly McpInvocationContext: unknown }>(
    "apps/server/src/mcp/McpInvocationContext.ts",
  );
  const { NodeHttpServer } = await fromServer<{
    readonly NodeHttpServer: { readonly layerTest: Layer };
  }>("@effect/platform-node");
  const runtime = ManagedRuntime.make(
    kit.catalog.pipe(
      LayerModule.provide(kit.dependencies),
      LayerModule.provideMerge(McpServer.McpServer.layer),
    ),
  );
  const withServer = <A>(f: (server: Server) => A) =>
    runtime.runPromise<A>(McpServer.McpServer.pipe(Effect.map((server: Server) => f(server))));
  // The shape the auth middleware gives a provider session's thread (see agentSurface.test.ts).
  const threadScope = {
    environmentId: "environment",
    requestNamespace: "provider:thread",
    thread: {
      threadId: "thread",
      providerSessionId: "provider:thread",
      providerInstanceId: "codex",
    },
    capabilities: new Set([
      "memory",
      "preview",
      "orchestration",
      "worktree",
      "device",
      "pull-requests",
    ]),
    issuedAt: 0,
  };
  const tools = await withServer((server) => server.tools.map(({ tool }) => tool));
  return {
    tools,
    listedAsThread: (listing) =>
      Effect.runPromise<ReadonlyArray<ListedTool>>(
        kit.serveCatalogOverHttp({ thread: threadScope }, listing).pipe(
          Effect.flatMap((http: { readonly listTools: (caller: string) => Program }) =>
            http.listTools("thread"),
          ),
          Effect.scoped,
          Effect.provide(NodeHttpServer.layerTest),
        ),
      ),
    callAsThread: (name, args) =>
      runtime.runPromise<CallResult>(
        McpServer.McpServer.pipe(
          Effect.flatMap((server: Server) => server.callTool({ name, arguments: args })),
          Effect.provideService(McpInvocationContext, threadScope),
          Effect.provideService(McpSchema.McpServerClient, kit.client),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
}
