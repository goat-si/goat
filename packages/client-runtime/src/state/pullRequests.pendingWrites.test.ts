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
