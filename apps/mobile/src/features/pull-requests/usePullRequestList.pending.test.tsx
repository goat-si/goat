import { RegistryContext } from "@effect/atom-react";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  WS_METHODS,
  type AuthSessionState,
} from "@goat/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import type { WsRpcProtocolClient } from "../../../../../packages/client-runtime/src/rpc/protocol";
import {
  makeTestRuntime,
  TARGET,
} from "../../../../../packages/client-runtime/src/state/pullRequests.testkit";

const state = vi.hoisted(() => ({ atoms: null as unknown }));
vi.mock("../../../../../packages/client-runtime/src/state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: grantedSessions,
    initialConfigValueAtom: initialConfigs,
  }),
}));
const initialConfigs = Atom.family((_id: EnvironmentId) => Atom.make<unknown>(null));
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
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { sessionGenerationAtom: Atom.family((_id: string) => Atom.make(0)) },
}));
vi.mock("../../state/pull-requests", async () => {
  const { pullRequestListHead, EMPTY_PULL_REQUEST_STATS_CACHE } = await import("./pullRequestList");
  return {
    pullRequestListPagesFamily: Atom.family((_key: string) =>
      Atom.make<ReturnType<typeof pullRequestListHead> | null>(null),
    ),
    pullRequestListStatsFamily: Atom.family((_key: string) =>
      Atom.make(EMPTY_PULL_REQUEST_STATS_CACHE),
    ),
    composerPullRequests: new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "invalidate"
            ? { run: async () => AsyncResult.success(undefined) }
            : (state.atoms as Record<PropertyKey, unknown>)[key],
      },
    ),
  };
});
import { usePullRequestList } from "./usePullRequestList";
import { pullRequestListPagesFamily } from "../../state/pull-requests";

class Refused extends Data.TaggedError("Refused") {}
it.effect("refresh during a refused write retains the host's title", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      let releaseWrite!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const reference = {
        projectId: ProjectId.make("project-1"),
        host: "github.example.com",
        repository: "acme/web",
        number: 1,
      };
      const entry = {
        ...reference,
        provider: SourceControlProviderKind.make("github"),
        projectTitle: "Web",
        title: "Original",
        url: "https://github.example.com/acme/web/pull/1",
        author: null,
        headBranch: "feature",
        baseBranch: "main",
        state: "open",
        isDraft: false,
        mergeability: "unknown",
        additions: 0,
        deletions: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        viewerReviewRequested: false,
        labels: [],
      };
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsList]: () =>
          Effect.succeed({
            entries: [entry],
            viewers: {},
            providers: [],
            errors: [],
            truncated: false,
            nextCursors: {},
          }),
        [WS_METHODS.pullRequestsUpdate]: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sent, undefined);
            yield* Effect.promise(() => release);
            return yield* new Refused();
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      state.atoms = atoms;
      const target = { environmentId: TARGET.environmentId, input: { state: "open" as const } };
      let latest!: ReturnType<typeof usePullRequestList>;
      function Probe() {
        const value = usePullRequestList([target], new Map());
        useLayoutEffect(() => {
          latest = value;
        });
        return null;
      }
      const root = createRoot(document.createElement("div"));
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      try {
        yield* Effect.promise(() =>
          act(async () => {
            root.render(
              <RegistryContext.Provider value={registry}>
                <Probe />
              </RegistryContext.Provider>,
            );
          }),
        );
        yield* Effect.promise(() =>
          act(async () => {
            await latest.onRefresh();
          }),
        );
        let writing!: ReturnType<typeof atoms.update.run>;
        yield* Effect.sync(() =>
          act(() => {
            writing = atoms.update.run(registry, {
              environmentId: target.environmentId,
              input: { ...reference, title: "Edited" },
            });
          }),
        );
        yield* Deferred.await(sent);
        yield* Effect.promise(() => act(async () => {}));
        expect(latest.entries.map((row) => row.title)).toEqual(["Edited"]);
        yield* Effect.promise(() =>
          act(async () => {
            await latest.onRefresh();
          }),
        );
        expect(
          registry.get(pullRequestListPagesFamily(JSON.stringify(target)))?.entries[0]?.title,
        ).toBe("Original");
        yield* Effect.promise(() =>
          act(async () => {
            releaseWrite();
            expect((await writing)._tag).toBe("Failure");
          }),
        );
        expect(latest.entries.map((row) => row.title)).toEqual(["Original"]);
      } finally {
        yield* Effect.sync(() => act(() => root.unmount()));
      }
    }),
  ),
);
