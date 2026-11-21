import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeTestRuntime, TARGET } from "./pullRequests.testkit.ts";

vi.mock("./session.ts", () => ({
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
class Refused extends Data.TaggedError("Refused") {}

it.effect("shows a pending title in detail and rolls it back if the host refuses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () => Effect.succeed({ title: "Original", labels: [] }),
        [WS_METHODS.pullRequestsUpdate]: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sent, undefined);
            yield* Deferred.await(release);
            return yield* new Refused();
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          host: "github.example.com",
          repository: "acme/web",
          number: 1,
        },
      };
      const detail = atoms.detail(target);
      registry.mount(detail);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      const writing = yield* Effect.promise(() =>
        atoms.update.run(registry, { ...target, input: { ...target.input, title: "Edited" } }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(sent);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).title).toBe("Edited");
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(writing))._tag).toBe("Failure");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).title).toBe("Original");
    }),
  ),
);

it.effect("keeps a later queued title when an earlier write fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstSent = yield* Deferred.make<void>();
      const secondSent = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () => Effect.succeed({ title: "Original", labels: [] }),
        [WS_METHODS.pullRequestsUpdate]: (input: { title: string }) =>
          Effect.gen(function* () {
            if (input.title === "First") {
              yield* Deferred.succeed(firstSent, undefined);
              yield* Deferred.await(releaseFirst);
              return yield* new Refused();
            }
            yield* Deferred.succeed(secondSent, undefined);
            yield* Deferred.await(releaseSecond);
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          host: "github.example.com",
          repository: "acme/web",
          number: 1,
        },
      };
      const detail = atoms.detail(target);
      registry.mount(detail);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      const first = yield* Effect.promise(() =>
        atoms.update.run(registry, { ...target, input: { ...target.input, title: "First" } }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(firstSent);
      const second = yield* Effect.promise(() =>
        atoms.update.run(registry, { ...target, input: { ...target.input, title: "Second" } }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondSent);
      expect((yield* Fiber.join(first))._tag).toBe("Failure");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).title).toBe("Second");
      yield* Deferred.succeed(releaseSecond, undefined);
      expect((yield* Fiber.join(second))._tag).toBe("Success");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).title).toBe("Second");
    }),
  ),
);

const actionRef = {
  projectId: ProjectId.make("project-1"),
  host: "github.example.com",
  repository: "acme/web",
  number: 1,
};
const actionTarget = { environmentId: TARGET.environmentId, input: actionRef };
const openDetail = {
  ...actionRef,
  state: "open" as const,
  isDraft: false,
  title: "Original",
  labels: [],
  observedAt: 100,
};
const reply = {
  ...openDetail,
  provider: "github",
  url: "https://github.example.com/acme/web/pull/1",
  headBranch: "feature",
  baseBranch: "main",
  updatedAt: "2026-10-27T10:00:00Z",
  observedAt: 200,
};
const listAnswer = (entries: readonly object[]) => ({
  entries,
  viewers: {},
  providers: [],
  errors: [],
  truncated: false,
  nextCursors: {},
});
const clientWith = (operations: Record<string, unknown>) =>
  ({
    [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
    ...operations,
  }) as unknown as WsRpcProtocolClient;

it.effect("rolls back a refused close in detail and the loaded open list", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = clientWith({
        [WS_METHODS.pullRequestsDetail]: () => Effect.succeed(openDetail),
        [WS_METHODS.pullRequestsList]: () => Effect.succeed(listAnswer([openDetail])),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sent, undefined);
            yield* Deferred.await(release);
            return yield* new Refused();
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const detail = atoms.detail(actionTarget);
      const list = atoms.list({ environmentId: TARGET.environmentId, input: { state: "open" } });
      registry.mount(detail);
      registry.mount(list);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true });
      const writing = yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...actionTarget,
          input: { ...actionRef, action: "close" },
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(sent);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("closed");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(list))).entries).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(writing))._tag).toBe("Failure");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("open");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(list))).entries).toHaveLength(1);
    }),
  ),
);

it.effect("keeps an accepted close visible while a bare reply triggers a fresh read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      const reread = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = clientWith({
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            reads++;
            if (reads > 1) {
              yield* Deferred.succeed(reread, undefined);
              yield* Deferred.await(release);
              return { ...openDetail, state: "closed", observedAt: 200 };
            }
            return openDetail;
          }),
        [WS_METHODS.pullRequestsRunAction]: () => Effect.void,
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const detail = atoms.detail(actionTarget);
      registry.mount(detail);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...actionTarget,
          input: { ...actionRef, action: "close" },
        }),
      );
      yield* Deferred.await(reread);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("closed");
      yield* Deferred.succeed(release, undefined);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).state,
      ).toBe("closed");
    }),
  ),
);

it.effect("leaves merge state to the host while the merge is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = clientWith({
        [WS_METHODS.pullRequestsDetail]: () => Effect.succeed(openDetail),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sent, undefined);
            yield* Deferred.await(release);
            return { ...reply, state: "open", autoMergeEnabled: true };
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const detail = atoms.detail(actionTarget);
      registry.mount(detail);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      const writing = yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...actionTarget,
          input: { ...actionRef, action: "merge" },
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(sent);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).state).toBe("open");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writing);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail)))).toMatchObject({
        state: "open",
        autoMergeEnabled: true,
      });
    }),
  ),
);

it.effect("shows a pending label on a loaded row and retains it on acceptance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const label = { name: "new", color: "abcdef" };
      const row = { ...openDetail, labels: [], updatedAt: "2026-01-01T00:00:00Z" };
      const client = clientWith({
        [WS_METHODS.pullRequestsDetail]: () => Effect.succeed(openDetail),
        [WS_METHODS.pullRequestsList]: () => Effect.succeed(listAnswer([row])),
        [WS_METHODS.pullRequestsLabelCandidates]: () =>
          Effect.succeed({
            candidates: [{ ...label, description: null, isApplied: false }],
            truncated: false,
          }),
        [WS_METHODS.pullRequestsSetLabels]: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sent, undefined);
            yield* Deferred.await(release);
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const list = atoms.list({ environmentId: TARGET.environmentId, input: { state: "open" } });
      const candidates = atoms.labelCandidates(actionTarget);
      registry.mount(list);
      registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });
      const writing = yield* Effect.promise(() =>
        atoms.setLabels.run(registry, {
          ...actionTarget,
          input: { ...actionRef, labels: ["new"], applied: true },
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(sent);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(list))).entries[0]?.labels).toEqual([
        label,
      ]);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(writing))._tag).toBe("Success");
      expect(Option.getOrThrow(AsyncResult.value(registry.get(list))).entries[0]?.labels).toEqual([
        label,
      ]);
    }),
  ),
);

it.effect("keeps an accepted label when an older options read finishes late", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let applied = false;
      let reads = 0;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = clientWith({
        [WS_METHODS.pullRequestsLabelCandidates]: () =>
          Effect.gen(function* () {
            reads++;
            const answer = {
              candidates: [{ name: "new", color: null, description: null, isApplied: applied }],
              truncated: false,
            };
            if (reads === 2) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return answer;
          }),
        [WS_METHODS.pullRequestsSetLabels]: () =>
          Effect.sync(() => {
            applied = true;
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const candidates = atoms.labelCandidates(actionTarget);
      registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });
      registry.refresh(candidates);
      yield* Deferred.await(started);
      yield* Effect.promise(() =>
        atoms.setLabels.run(registry, {
          ...actionTarget,
          input: { ...actionRef, labels: ["new"], applied: true },
        }),
      );
      yield* Deferred.succeed(release, undefined);
      expect(
        (yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true }))
          .candidates[0]?.isApplied,
      ).toBe(true);
    }),
  ),
);

it.effect("shows a pending close in checks and rolls it back on refusal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = clientWith({
        [WS_METHODS.pullRequestsChecks]: () =>
          Effect.succeed({ state: "open", checks: [], observedAt: 100 }),
        [WS_METHODS.pullRequestsRunAction]: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sent, undefined);
            yield* Deferred.await(release);
            return yield* new Refused();
          }),
      });
      const { atoms, registry } = yield* makeTestRuntime(client);
      const checks = atoms.checks(actionTarget);
      registry.mount(checks);
      yield* AtomRegistry.getResult(registry, checks, { suspendOnWaiting: true });
      const writing = yield* Effect.promise(() =>
        atoms.runAction.run(registry, {
          ...actionTarget,
          input: { ...actionRef, action: "close" },
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(sent);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(checks)))?.state).toBe("closed");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writing);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(checks)))?.state).toBe("open");
    }),
  ),
);
