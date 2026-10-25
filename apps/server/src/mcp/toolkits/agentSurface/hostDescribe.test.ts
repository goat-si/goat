import { describe, expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  type ProviderInteractionMode,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import packageJson from "../../../../package.json" with { type: "json" };
import { layerNoFleetSync } from "../../../goatclaw/FleetSync.testkit.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as LinkedHosts from "../../../linkedHosts/LinkedHosts.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import {
  host,
  initialize,
  type ToolAnswer,
  withRemote,
} from "../../../sshRemote/SshRemoteDispatch.hostCall.testkit.ts";
import * as ThreadResults from "../../../threadResults/ThreadResultService.ts";
import { catalog, client, dependencies } from "../../agentSurface.testkit.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadReplicaService from "../../ThreadReplicaService.ts";

const CALLER = ThreadId.make("thread:describe-host");
const base = {
  environmentId: EnvironmentId.make("environment"),
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview"] as const),
};
const scopes = {
  thread: {
    ...base,
    requestNamespace: "thread",
    thread: {
      threadId: CALLER,
      providerSessionId: "provider:thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
  readOnlyClient: {
    ...base,
    requestNamespace: "read-only",
    thread: undefined,
    client: { sessionId: "read-only", label: "Agent", access: "read-only" },
  },
} satisfies Record<string, McpInvocationScope>;

interface CallerState {
  shell: OrchestrationV2ThreadShell | null;
}
const callerState = (
  modes: {
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly activeRunId?: RunId | null;
  } = {},
): CallerState => ({ shell: liveThreadShell(CALLER, modes) });

interface Options {
  readonly answer: (request: {
    readonly method: string;
    readonly tool?: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }) => ToolAnswer | undefined;
  readonly scope?: McpInvocationScope;
  readonly caller?: CallerState;
  readonly linkedHost?: LinkedHosts.LinkedHostCredential;
  readonly profile?: Profiles.EffectiveProfile;
  /** Runs when the remote session is issued, after the caller passed every earlier check. */
  readonly onSession?: () => void;
}

const answered = (value: unknown): ToolAnswer => ({
  result: { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] },
});

/** goat_describe (or goat_call around it) as this caller, over the real host-read path. */
const describeAs = (options: Options, calls: ReadonlyArray<readonly [string, object]>) => {
  const caller = options.caller ?? callerState();
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.sync(() => caller.shell),
  });
  // The real dispatch withRemote drives, never the inert one the catalog's dependencies carry.
  const hostReads = (dispatch: SshRemoteDispatch.SshRemoteDispatch["Service"]) =>
    HostThreadsMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerNoFleetSync,
          threads,
          Layer.succeed(SshRemoteDispatch.SshRemoteDispatch, dispatch),
          Layer.mock(ThreadResults.ThreadResultService)({}),
          Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
          Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
          Layer.mock(LaunchWatchService.LaunchWatchService)({}),
          Layer.mock(ThreadReplicaService.ThreadReplicaService)({}),
        ),
      ),
    );
  const overrides = (dispatch: SshRemoteDispatch.SshRemoteDispatch["Service"]) =>
    Layer.mergeAll(
      threads,
      hostReads(dispatch),
      Layer.mock(LinkedHosts.LinkedHosts)({
        find: (name) =>
          Effect.succeed(
            options.linkedHost?.host.name === name
              ? Option.some(options.linkedHost)
              : Option.none(),
          ),
      }),
      ...(options.profile === undefined
        ? []
        : [
            Layer.mock(Profiles.PermissionProfiles)({
              resolve: () => Effect.succeed(options.profile as Profiles.EffectiveProfile),
            }),
          ]),
    );
  const body = Effect.gen(function* () {
    const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
    const served = catalog.pipe(
      Layer.provide(Layer.mergeAll(dependencies, overrides(dispatch))),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    return yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const results: Array<McpSchema.CallToolResult> = [];
      for (const [name, args] of calls)
        results.push(yield* server.callTool({ name, arguments: args }));
      return results;
    }).pipe(
      Effect.provideService(McpInvocationContext, options.scope ?? scopes.thread),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(served),
    );
  });
  return withRemote(
    {
      answer: (request) => initialize(request) ?? options.answer(request) ?? { status: 500 },
      ...(options.linkedHost === undefined ? {} : { linkedHost: options.linkedHost }),
      beforeSessionIssue: () => Effect.sync(() => options.onSession?.()),
    },
    body,
  ).pipe(
    Effect.map(({ result, record }) => {
      if (result._tag === "Failure") throw new Error(`harness failed: ${String(result.failure)}`);
      return { results: result.success, record };
    }),
  );
};

const textOf = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const codeOf = (result: McpSchema.CallToolResult) => /"code":"([a-z_]+)"/.exec(textOf(result))?.[1];
const valueOf = (result: McpSchema.CallToolResult) => {
  expect(result.isError, textOf(result)).not.toBe(true);
  return result.structuredContent as Record<string, any>;
};

const entry = (path: string, effect: "read" | "write", now = true, reason?: string) => ({
  path,
  name: `goat_${path.replace(".", "_")}`,
  summary: path,
  effect,
  requires: "either",
  available: now ? { now } : { now, reason: reason ?? "refused" },
  description: path,
  match: "all",
  matchedWords: ["x"],
  unmatchedWords: [],
});

/** A host's search answer; without build it has the shape GOAT gave before reporting one. */
const remoteSearch = (
  entries: ReadonlyArray<ReturnType<typeof entry>>,
  extra: { readonly build?: object; readonly nextCursor?: string } = {},
) => ({
  depth: "search",
  surfaceVersion: "remote01",
  ...(extra.build === undefined ? {} : { build: extra.build }),
  query: "x",
  mode: "all",
  entries,
  total: entries.length + (extra.nextCursor === undefined ? 0 : 1),
  returned: entries.length,
  truncated: extra.nextCursor !== undefined,
  ...(extra.nextCursor === undefined ? {} : { nextCursor: extra.nextCursor }),
  coverage: {
    fields: ["path", "name", "summary", "description", "guide"],
    resources: "all",
    searched: 400,
    ignoredWords: [],
    notServed: 0,
    unavailableToCaller: 1,
  },
});

const describeAnswer =
  (value: unknown) =>
  (request: { readonly tool?: string }): ToolAnswer | undefined =>
    request.tool === "goat_describe" ? answered(value) : undefined;

describe("goat_describe with host", () => {
  it.effect.each(["goat_describe", "goat_call"] as const)(
    "searches the host's registry and says which of its paths this caller can call there (%s)",
    (route) =>
      Effect.gen(function* () {
        const args = { host, query: "teleport" };
        const { results, record } = yield* describeAs(
          {
            answer: describeAnswer(
              remoteSearch([
                entry("fleet.teleport", "read"),
                entry("note.read", "read"),
                entry("thread.read", "read"),
                entry("thread.list", "read", false, "Needs an agent running inside a GOAT thread."),
              ]),
            ),
          },
          [
            route === "goat_describe"
              ? ["goat_describe", args]
              : ["goat_call", { path: "surface.describe", args }],
          ],
        );
        const envelope = valueOf(results[0]!);
        const value = route === "goat_describe" ? envelope : envelope["value"];
        expect(value["host"]).toBe(host);
        const available = Object.fromEntries(
          (value["entries"] as ReadonlyArray<{ path: string; available: object }>).map((found) => [
            found.path,
            found.available,
          ]),
        );
        // Only on the newer host: listed, so the agent knows it exists, but not callable from here.
        expect(available["fleet.teleport"]).toEqual({
          now: false,
          reason: expect.stringContaining("GOAT on this machine does not have fleet.teleport"),
        });
        expect(available["note.read"]).toEqual({
          now: false,
          reason: expect.stringContaining("note.read does not take host on this machine"),
        });
        expect(available["thread.read"]).toEqual({ now: true });
        expect(available["thread.list"]).toEqual({
          now: false,
          reason: `On ${host}: Needs an agent running inside a GOAT thread.`,
        });
        expect(value["coverage"]).toMatchObject({ unavailableToCaller: 1, unavailableFromHere: 2 });
        // The host searches its own registry; host itself is never forwarded.
        expect(record.toolCallArguments).toEqual([
          { tool: "goat_describe", arguments: { query: "teleport" } },
        ]);
      }),
  );

  it.effect.each([
    ["older", "0.0.1", true],
    ["the same", packageJson.version, false],
    ["newer", "999.0.0", false],
    ["unreported, as before hosts reported builds", undefined, null],
    ["unordered against this build", `${packageJson.version}-dev.abcdef`, null],
  ] as const)("reports coverage.hostOlder for a host whose build is %s", ([, version, older]) =>
    Effect.gen(function* () {
      const { results } = yield* describeAs(
        {
          answer: describeAnswer(
            remoteSearch(
              [entry("thread.read", "read")],
              version === undefined ? {} : { build: { version } },
            ),
          ),
        },
        [["goat_describe", { host, query: "read" }]],
      );
      const value = valueOf(results[0]!);
      expect(value["coverage"]["hostOlder"]).toBe(older);
      expect(value["build"]).toEqual(version === undefined ? undefined : { version });
    }),
  );

  it.effect(
    "keeps a host without goat_describe, an unreachable host and an unknown one apart",
    () =>
      Effect.gen(function* () {
        const outdated = yield* describeAs(
          { answer: () => ({ rpcError: "Tool 'goat_describe' not found" }) },
          [["goat_describe", { host, query: "read" }]],
        );
        expect(codeOf(outdated.results[0]!)).toBe("remote_outdated");
        expect(textOf(outdated.results[0]!)).toContain(
          `GOAT on ${host} does not have goat_describe`,
        );

        const unreachable = yield* describeAs({ answer: () => ({ throws: "fetch failed" }) }, [
          ["goat_describe", { host, query: "read" }],
        ]);
        expect(codeOf(unreachable.results[0]!)).toBe("host_unavailable");

        const unknown = yield* describeAs({ answer: () => undefined }, [
          ["goat_describe", { host: "elsewhere", query: "read" }],
        ]);
        expect(codeOf(unknown.results[0]!)).toBe("invalid_request");
        expect(textOf(unknown.results[0]!)).toContain("elsewhere");
        expect(unknown.record.toolCalls).toEqual([]);
      }),
  );

  it.effect.each([
    ["a read-only client", { scope: scopes.readOnlyClient }, "reaches other machines"],
    [
      "a thread whose run ended",
      { caller: callerState({ activeRunId: null }) },
      "parent_not_active",
    ],
    ["a deleted thread", { caller: { shell: null } }, "thread_not_found"],
  ] as const)("refuses a host describe from %s before reaching the host", ([, options, refusal]) =>
    Effect.gen(function* () {
      const { results, record } = yield* describeAs(
        { ...options, answer: describeAnswer(remoteSearch([])) },
        [
          ["goat_describe", { host, query: "read" }],
          ["goat_call", { path: "surface.describe", args: { host, query: "read" } }],
        ],
      );
      expect(textOf(results[0]!)).toContain(refusal);
      expect(results[0]!.isError).toBe(true);
      expect(textOf(results[1]!)).toContain(refusal);
      expect(record.toolCalls).toEqual([]);
    }),
  );

  it.effect("still answers a read-only client's local describe", () =>
    Effect.gen(function* () {
      const { results } = yield* describeAs(
        { scope: scopes.readOnlyClient, answer: () => undefined },
        [["goat_describe", { query: "read thread" }]],
      );
      const value = valueOf(results[0]!);
      expect(value["host"]).toBeUndefined();
      expect(value["build"]).toMatchObject({ version: packageJson.version });
      expect(value["coverage"]["hostOlder"]).toBeUndefined();
    }),
  );

  it.effect("sends nothing when the caller's authority drops while connecting", () =>
    Effect.gen(function* () {
      const caller = callerState();
      const { results, record } = yield* describeAs(
        {
          caller,
          answer: describeAnswer(remoteSearch([])),
          onSession: () => {
            caller.shell = liveThreadShell(CALLER, { runtimeMode: "auto" });
          },
        },
        [["goat_describe", { host, query: "read" }]],
      );
      expect(codeOf(results[0]!)).toBe("runtime_mode_escalation_denied");
      expect(record.toolCalls).toEqual([]);
    }),
  );

  it.effect.each([
    [
      "a plan-mode caller",
      { caller: callerState({ interactionMode: "plan" }) },
      "default interaction mode",
    ],
    [
      "a caller below a linked host's access",
      {
        caller: callerState({ runtimeMode: "auto" }),
        linkedHost: {
          host: {
            name: host,
            baseUrl: "http://127.0.0.1:41001",
            environmentId: "environment:linked",
            label: "Linked",
            serverVersion: packageJson.version,
            access: "full-access",
            linkedAt: "2026-10-01T00:00:00.000Z",
            expiresAt: "2027-10-01T00:00:00.000Z",
          },
          token: "link-token",
        },
      },
      "more than this caller's auto",
    ],
    [
      "a profile that does not allow the host",
      {
        profile: {
          enabled: true,
          runtimeMode: "full-access",
          profile: { ...BUILTIN_PERMISSION_PROFILES["owner"]!, hosts: ["other-box"] },
        },
      },
      `does not allow host ${host}`,
    ],
  ] as const)(
    "reports a host's write unavailable to %s, as a routed write would be refused",
    ([, options, refusal]) =>
      Effect.gen(function* () {
        const { results } = yield* describeAs(
          {
            ...options,
            answer: describeAnswer(
              remoteSearch([entry("thread.send", "write"), entry("thread.read", "read")]),
            ),
          },
          [["goat_describe", { host, query: "send" }]],
        );
        const value = valueOf(results[0]!);
        const [send, read] = value["entries"] as ReadonlyArray<{
          available: { now: boolean; reason?: string };
        }>;
        expect(send!.available.now).toBe(false);
        expect(send!.available.reason).toContain(refusal);
        expect(read!.available).toEqual({ now: true });
      }),
  );

  it.effect("reports a host's write available to a caller that can send it there", () =>
    Effect.gen(function* () {
      const { results } = yield* describeAs(
        { answer: describeAnswer(remoteSearch([entry("thread.send", "write")])) },
        [["goat_describe", { host, query: "send" }]],
      );
      expect(valueOf(results[0]!)["entries"][0].available).toEqual({ now: true });
    }),
  );

  it.effect("binds a host's nextCursor to that host and that search", () =>
    Effect.gen(function* () {
      const first = remoteSearch([entry("thread.read", "read")], { nextCursor: "remote-page-2" });
      const { results: [page] = [] } = yield* describeAs({ answer: describeAnswer(first) }, [
        ["goat_describe", { host, query: "read" }],
      ]);
      const cursor = valueOf(page!)["nextCursor"] as string;
      expect(cursor).not.toBe("remote-page-2");

      const { results: [local] = [] } = yield* describeAs({ answer: () => undefined }, [
        ["goat_describe", { query: "thread", limit: 1 }],
      ]);
      const localCursor = valueOf(local!)["nextCursor"] as string;

      const { results, record } = yield* describeAs({ answer: describeAnswer(remoteSearch([])) }, [
        ["goat_describe", { host, query: "read", cursor }],
        ["goat_describe", { host: "other-box", query: "read", cursor }],
        ["goat_describe", { query: "read", cursor }],
        ["goat_describe", { host, query: "send", cursor }],
        ["goat_describe", { host, query: "thread", cursor: localCursor }],
        ["goat_describe", { host, query: "read", cursor: "not-a-cursor" }],
      ]);
      const [next, otherHost, withoutHost, otherQuery, localOnHost, malformed] = results;
      valueOf(next!);
      expect(textOf(otherHost!)).toContain(`continues a search on ${host}, not other-box`);
      expect(textOf(withoutHost!)).toContain(`continues a search on ${host}. Pass host ${host}`);
      expect(textOf(otherQuery!)).toContain("belongs to another search");
      expect(textOf(localOnHost!)).toContain(`not a nextCursor from a search on ${host}`);
      expect(textOf(malformed!)).toContain(`not a nextCursor from a search on ${host}`);
      for (const refused of [otherHost, withoutHost, otherQuery, localOnHost, malformed])
        expect(codeOf(refused!)).toBe("invalid_request");
      // Only the matching continuation reached the host, with the host's own cursor.
      expect(record.toolCallArguments).toEqual([
        { tool: "goat_describe", arguments: { query: "read", cursor: "remote-page-2" } },
      ]);
    }),
  );
});
