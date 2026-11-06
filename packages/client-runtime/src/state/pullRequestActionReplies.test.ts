import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import { AuthSourceControlWriteScope, type AuthSessionState } from "@goat/contracts";
import { EnvironmentId, ProjectId, WS_METHODS, type PullRequestListInput } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
} from "./pullRequests.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { executeAtomQuery, queryPersistenceKey } from "./runtime.ts";
import { EnvironmentQueryStore } from "./queryPersistence.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grantedSessions }),
}));
const grantedSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSourceControlWriteScope],
    }),
  ),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client: {
      ...client,
      [WS_METHODS.pullRequestsInvalidate]:
        client[WS_METHODS.pullRequestsInvalidate] ?? (() => Effect.void),
    },
    initialConfig: client[WS_METHODS.serverGetConfig]?.({}).pipe(Effect.orDie) ?? Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (
  client: WsRpcProtocolClient,
  localClient?: WsRpcProtocolClient,
  localOrigin = false,
  onAnswer: Parameters<typeof createPullRequestEnvironmentAtoms>[1] = {},
  queryStore: typeof EnvironmentQueryStore.Service = null,
) {
  const originTarget = localOrigin
    ? new PrimaryConnectionTarget({
        ...TARGET,
        httpBaseUrl: "http://localhost:3774",
        wsBaseUrl: "ws://localhost:3774",
      })
    : TARGET;
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: originTarget,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const localTarget = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("local-environment"),
    label: "Local environment",
    httpBaseUrl: "http://localhost:3773",
    wsBaseUrl: "ws://localhost:3773",
  });
  const localSupervisor = {
    ...supervisor,
    target: localTarget,
    session: yield* SubscriptionRef.make(Option.some(session(localClient ?? client))),
  };
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [
          originTarget.environmentId,
          { target: originTarget, profile: Option.none(), enabled: true },
        ],
        ...(localClient === undefined
          ? []
          : [
              [
                localTarget.environmentId,
                { target: localTarget, profile: Option.none(), enabled: true },
              ] as const,
            ]),
      ]),
    ),
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        environmentId === localTarget.environmentId ? localSupervisor : supervisor,
      ),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        PullRequestDiffLoader.PullRequestDiffLoader,
        PullRequestDiffLoader.PullRequestDiffLoader.of({ load: () => Effect.die("unused") }),
      ),
      Layer.succeed(EnvironmentQueryStore, queryStore),
    ),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime, onAnswer);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { runtime, atoms, registry, environmentRegistry, supervisor, localSupervisor };
});

const actionReference = {
  projectId: ProjectId.make("project-1"),
  host: "github.example.com",
  repository: "acme/web",
  number: 1,
};
const actionReply = {
  ...actionReference,
  provider: "github",
  title: "Ship it",
  url: "https://github.example.com/acme/web/pull/1",
  headBranch: "feature",
  baseBranch: "main",
  state: "merged" as const,
  isDraft: false,
  updatedAt: "2026-10-27T10:00:00Z",
  observedAt: 200,
};

function actionReplyClient(overrides: Record<string, unknown> = {}) {
  return {
    [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
    [WS_METHODS.pullRequestsRunAction]: () => Effect.succeed(actionReply),
    ...overrides,
  } as unknown as WsRpcProtocolClient;
}

it.effect("shows an action's reply in loaded readers and moves list rows without reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reads: string[] = [];
      const open = { ...actionReference, state: "open", isDraft: true, observedAt: 100 };
      const read = (name: string) => () =>
        Effect.sync(() => {
          reads.push(name);
          return open;
        });
      const replies: unknown[] = [];
      const listAnswers: unknown[] = [];
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsDetail]: read("detail"),
        [WS_METHODS.pullRequestsPreview]: read("preview"),
        [WS_METHODS.pullRequestsSummary]: read("summary"),
        [WS_METHODS.pullRequestsList]: (input: { readonly state: string }) =>
          Effect.sync(() => {
            reads.push(`list:${input.state}`);
            return {
              entries: input.state === "merged" ? [] : [open],
              viewers: {},
              providers: [],
              errors: [],
              truncated: false,
              nextCursors: {},
            };
          }),
      });
      const saved = new Map<string, string>();
      const { atoms, registry, runtime } = yield* makeTestRuntime(
        client,
        undefined,
        false,
        {
          actionReply: (target, reply) => Effect.sync(() => replies.push({ target, reply })),
          list: (_target, value) => Effect.sync(() => listAnswers.push(value.entries)),
        },
        {
          load: (_environmentId, key) => Effect.sync(() => Option.fromUndefinedOr(saved.get(key))),
          save: (_environmentId, key, payload) => Effect.sync(() => void saved.set(key, payload)),
        },
      );
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const list = (input: PullRequestListInput) =>
        atoms.list({ environmentId: target.environmentId, input });
      const readers: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<object, unknown>>> = [
        atoms.detail(target),
        atoms.preview(target),
        createLinkedPullRequestSummaryAtomFamily(runtime, atoms.refreshes)(target),
      ];
      const all = list({ state: "all" });
      const openDrafts = list({ state: "open", filters: { draft: "only" } });
      const merged = list({ state: "merged" });
      for (const atom of [...readers, all, openDrafts, merged]) {
        registry.mount(atom);
        yield* Effect.promise(() => executeAtomQuery(registry, atom));
      }
      reads.length = 0;

      const answer = yield* Effect.promise(() =>
        atoms.runAction.run(registry, { ...target, input: { ...target.input, action: "merge" } }),
      );

      expect(answer).toMatchObject({ _tag: "Success", value: actionReply });
      for (const atom of readers) {
        expect(Option.getOrThrow(AsyncResult.value(registry.get(atom)))).toMatchObject({
          state: "merged",
          isDraft: false,
          title: "Ship it",
        });
      }
      expect(Option.getOrThrow(AsyncResult.value(registry.get(all))).entries).toMatchObject([
        // The row keeps its own read time: the reply does not carry its checks or labels.
        { state: "merged", isDraft: false, observedAt: 100 },
      ]);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(openDrafts))).entries).toEqual([]);
      expect(replies).toEqual([{ target, reply: actionReply }]);
      // A cold start paints the saved copy, so the patch must replace the saved answer.
      const summaryKey = queryPersistenceKey(
        "environment-data:pull-requests:linked-summary",
        actionReference,
      );
      expect(JSON.parse(saved.get(summaryKey) ?? "null")).toMatchObject({ state: "merged" });
      // Snapshot writers see the patched rows the way they see an answer.
      expect(listAnswers).toContainEqual([expect.objectContaining({ state: "merged" })]);
      // Only a read can place a row the listing did not hold.
      yield* AtomRegistry.getResult(registry, merged, { suspendOnWaiting: true });
      expect(reads).toEqual(["list:merged"]);
    }),
  ),
);

it.effect("keeps an action's reply when a refresh started before the action answers late", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let state: "open" | "merged" = "open";
      let reads = 0;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            reads++;
            const snapshot = { ...actionReference, state, isDraft: false, observedAt: 100 };
            if (reads === 2) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release).pipe(
                Effect.onExit(() => Deferred.succeed(settled, undefined)),
              );
            }
            return snapshot;
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.sync(() => {
            state = "merged";
            return actionReply;
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const detail = atoms.detail(target);
      registry.mount(detail);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      registry.refresh(detail);
      yield* Deferred.await(started);

      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "merge" },
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(settled);

      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).state,
      ).toBe("merged");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("merged");
    }),
  ),
);

it.effect("keeps a list read the server's refresh started before the action replied", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let state: "open" | "merged" = "open";
      let reads = 0;
      const actionInputs: unknown[] = [];
      const listWaiting = Latch.makeUnsafe();
      const release = yield* Deferred.make<void>();
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsList]: () =>
          Effect.gen(function* () {
            reads++;
            const entries = [
              { ...actionReference, state, isDraft: false, updatedAt: actionReply.updatedAt },
            ];
            if (reads === 2) yield* Deferred.await(release);
            return {
              entries,
              viewers: {},
              providers: [],
              errors: [],
              truncated: false,
              nextCursors: {},
            };
          }),
        [WS_METHODS.pullRequestsRunAction]: (input: unknown) =>
          Effect.gen(function* () {
            actionInputs.push(input);
            state = "merged";
            // The server announces its refresh before it replies.
            yield* PubSub.publish(refreshEvents, 1);
            yield* listWaiting.await;
            return actionReply;
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const list = atoms.list({ environmentId: target.environmentId, input: { state: "all" } });
      const unmount = registry.mount(list);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Effect.promise(() => executeAtomQuery(registry, list));
      const stop = registry.subscribe(list, (result) => {
        if (result.waiting) listWaiting.openUnsafe();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));

      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "merge" },
        }),
      );
      yield* Deferred.succeed(release, undefined);

      expect(
        (yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true })).entries,
      ).toMatchObject([{ state: "merged" }]);
      expect(reads).toBe(2);
      expect(actionInputs).toEqual([expect.objectContaining({ replyWithSummary: true })]);
    }),
  ),
);

it.effect("restarts a list page read sent while the action was in flight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let state: "open" | "closed" = "open";
      let pageReads = 0;
      const actionSent = yield* Deferred.make<void>();
      const pageStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const listResult = (entries: ReadonlyArray<object>) => ({
        entries,
        viewers: {},
        providers: [],
        errors: [],
        truncated: false,
        nextCursors: {},
      });
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsList]: (input: PullRequestListInput) =>
          Effect.gen(function* () {
            const entries =
              state === "open"
                ? [{ ...actionReference, state, isDraft: false, updatedAt: "2026-10-27T09:00:00Z" }]
                : [];
            if (input.cursors !== undefined && ++pageReads === 2) {
              yield* Deferred.succeed(pageStarted, undefined);
              yield* Deferred.await(release).pipe(
                Effect.onExit(() => Deferred.succeed(settled, undefined)),
              );
            }
            return listResult(input.cursors === undefined ? [] : entries);
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(actionSent, undefined);
            yield* Deferred.await(pageStarted);
            state = "closed";
            yield* PubSub.publish(refreshEvents, 1);
            return { ...actionReply, state: "closed" };
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const listInput = { state: "open" } as const;
      const head = atoms.list({ environmentId: target.environmentId, input: listInput });
      const page = atoms.list({
        environmentId: target.environmentId,
        input: { ...listInput, cursors: { "github.example.com": "page-2" } },
      });
      for (const atom of [head, page]) {
        const unmount = registry.mount(atom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        yield* Effect.promise(() => executeAtomQuery(registry, atom));
      }

      const action = yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "close" },
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(actionSent);
      // Loading more rows re-reads a page while the close is on the wire.
      registry.refresh(page);
      yield* Fiber.join(action);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(settled);

      expect(
        (yield* AtomRegistry.getResult(registry, page, { suspendOnWaiting: true })).entries,
      ).toEqual([]);
    }),
  ),
);

it.effect("shows a reopen reply at once and re-reads the fields it lacks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      const release = yield* Deferred.make<void>();
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            reads++;
            if (reads === 1) return { ...actionReference, state: "closed", observedAt: 100 };
            yield* Deferred.await(release);
            return { ...actionReference, state: "open", observedAt: 300 };
          }),
        [WS_METHODS.pullRequestsRunAction]: () => Effect.succeed({ ...actionReply, state: "open" }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const detail = atoms.detail(target);
      registry.mount(detail);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });

      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "reopen" },
        }),
      );

      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("open");
      expect(reads).toBe(2);
      yield* Deferred.succeed(release, undefined);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).observedAt,
      ).toBe(300);
    }),
  ),
);

it.effect("keeps each reader's read time when a reply leaves its checks as they were", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const shown = {
        ...actionReference,
        state: "open",
        isDraft: true,
        updatedAt: "2026-10-27T09:00:00Z",
        observedAt: 100,
        checks: [{ status: "success" }],
        checksState: "passing",
      };
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsDetail]: () => Effect.succeed(shown),
        [WS_METHODS.pullRequestsSummary]: () => Effect.succeed(shown),
        [WS_METHODS.pullRequestsList]: () =>
          Effect.succeed({
            entries: [shown],
            viewers: {},
            providers: [],
            errors: [],
            truncated: false,
            nextCursors: {},
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.succeed({ ...actionReply, state: "open", observedAt: 300 }),
      });
      const answeredAt: Array<number | undefined> = [];
      const { atoms, registry, runtime } = yield* makeTestRuntime(client, undefined, false, {
        detail: (_target, value) => Effect.sync(() => answeredAt.push(value.observedAt)),
      });
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const readers: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<object, unknown>>> = [
        atoms.detail(target),
        createLinkedPullRequestSummaryAtomFamily(runtime, atoms.refreshes)(target),
      ];
      const list = atoms.list({ environmentId: target.environmentId, input: { state: "all" } });
      for (const atom of [...readers, list]) {
        registry.mount(atom);
        yield* Effect.promise(() => executeAtomQuery(registry, atom));
      }

      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "ready" },
        }),
      );

      // Checks read at 100 must not pass for a read at 300 against a newer checks read.
      for (const atom of readers) {
        expect(Option.getOrThrow(AsyncResult.value(registry.get(atom)))).toMatchObject({
          isDraft: false,
          observedAt: 100,
        });
      }
      expect(Option.getOrThrow(AsyncResult.value(registry.get(list))).entries).toMatchObject([
        { isDraft: false, checksState: "passing", observedAt: 100 },
      ]);
      expect(answeredAt).toEqual([100, 100]);
    }),
  ),
);

it.effect("re-reads an unstamped preview rather than order a reply against it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      const client = actionReplyClient({
        // Previews from servers before action replies carry neither update nor read time.
        [WS_METHODS.pullRequestsPreview]: () =>
          Effect.sync(() => {
            reads++;
            return {
              ...actionReference,
              title: "Reopened elsewhere",
              url: actionReply.url,
              author: null,
              state: "open",
              isDraft: false,
              createdAt: "2026-10-27T08:00:00Z",
            };
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.succeed({ ...actionReply, state: "closed" }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const preview = atoms.preview(target);
      registry.mount(preview);
      yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true });

      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "close" },
        }),
      );

      expect(Option.getOrThrow(AsyncResult.value(registry.get(preview))).state).toBe("open");
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).state,
      ).toBe("open");
      expect(reads).toBe(2);
    }),
  ),
);

it.effect("leaves a loaded list page alone when the reply concerns none of its rows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let pageReads = 0;
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsList]: () =>
          Effect.sync(() => {
            pageReads++;
            return {
              entries: [
                {
                  ...actionReference,
                  number: 2,
                  state: "open",
                  isDraft: false,
                  updatedAt: "2026-10-27T09:00:00Z",
                },
              ],
              viewers: {},
              providers: [],
              errors: [],
              truncated: false,
              nextCursors: {},
            };
          }),
        [WS_METHODS.pullRequestsRunAction]: () => Effect.succeed({ ...actionReply, state: "open" }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const page = atoms.list({
        environmentId: target.environmentId,
        input: { state: "open", cursors: { "github.example.com": "page-2" } },
      });
      const unmount = registry.mount(page);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Effect.promise(() => executeAtomQuery(registry, page));

      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "ready" },
        }),
      );

      yield* AtomRegistry.getResult(registry, page, { suspendOnWaiting: true });
      expect(pageReads).toBe(1);
    }),
  ),
);

it.effect("keeps the server's post-commit read when a reopen reply lacks fields", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let reads = 0;
      const detailWaiting = Latch.makeUnsafe();
      const release = yield* Deferred.make<void>();
      const client = actionReplyClient({
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            reads++;
            if (reads === 1) return { ...actionReference, state: "closed", observedAt: 100 };
            yield* Deferred.await(release);
            return { ...actionReference, state: "open", observedAt: 300 };
          }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.gen(function* () {
            // The server announces its refresh before it replies.
            yield* PubSub.publish(refreshEvents, 1);
            yield* detailWaiting.await;
            return { ...actionReply, state: "open" };
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = { environmentId: TARGET.environmentId, input: actionReference };
      const detail = atoms.detail(target);
      const unmount = registry.mount(detail);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      const stop = registry.subscribe(detail, (result) => {
        if (result.waiting) detailWaiting.openUnsafe();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));

      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...target,
          input: { ...actionReference, action: "reopen" },
        }),
      );
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("open");
      yield* Deferred.succeed(release, undefined);

      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).observedAt,
      ).toBe(300);
      expect(reads).toBe(2);
    }),
  ),
);

it.effect.each([
  ["a newer update", "open", "2026-10-27T10:00:01Z", 100, "open"],
  ["a merge", "merged", "2026-10-27T09:00:00Z", 100, "open"],
] as const)(
  "keeps %s when an older or reverting action reply arrives",
  ([, shownState, updatedAt, observedAt, replyState]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const shown = {
          ...actionReference,
          state: shownState,
          isDraft: true,
          updatedAt,
          observedAt,
        };
        const client = actionReplyClient({
          [WS_METHODS.pullRequestsDetail]: () => Effect.succeed(shown),
          [WS_METHODS.pullRequestsPreview]: () => Effect.succeed(shown),
          [WS_METHODS.pullRequestsRunAction]: () =>
            Effect.succeed({ ...actionReply, state: replyState }),
        });
        const { atoms, registry } = yield* makeTestRuntime(client);
        const target = { environmentId: TARGET.environmentId, input: actionReference };
        const readers = [atoms.detail(target), atoms.preview(target), atoms.previewCard(target)];
        for (const reader of readers) {
          registry.mount(reader);
          yield* AtomRegistry.getResult(registry, reader, { suspendOnWaiting: true });
        }

        yield* Effect.promise(() =>
          atoms.runAction.run(registry, {
            ...target,
            input: { ...actionReference, action: "ready" },
          }),
        );
        for (const reader of readers) {
          expect(Option.getOrThrow(AsyncResult.value(registry.get(reader)))).toMatchObject({
            state: shownState,
            isDraft: true,
          });
        }
      }),
    ),
);
