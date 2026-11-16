import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthSessionState,
  type ScopedProjectRef,
  WS_METHODS,
} from "@goat/contracts";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { recordSessionPublished } from "../connection/sessionPublication.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentProject } from "./models.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const PROJECT_ID = ProjectId.make("scratch");

// Publication order is page-wide, so every test names its own computer.
const makeHarness = Effect.fn("TestProjectCommandSession.makeHarness")(function* (name: string) {
  const environmentId = EnvironmentId.make(name);
  const project = {
    id: PROJECT_ID,
    environmentId,
    workspaceRoot: "/scratch",
  } as EnvironmentProject;
  const scratchAnswered = yield* Deferred.make<void>();
  const createFromThreadCalls: Array<string> = [];
  const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
  const publish = (label: string) =>
    Effect.suspend(() => {
      const next = {
        client: {
          [WS_METHODS.projectsEnsureScratch]: () =>
            Deferred.succeed(scratchAnswered, undefined).pipe(Effect.as({ projectId: PROJECT_ID })),
          [WS_METHODS.projectsCreateFromThread]: () =>
            Effect.sync(() => {
              createFromThreadCalls.push(label);
              return { projectId: PROJECT_ID };
            }),
        },
      } as unknown as RpcSession;
      recordSessionPublished(environmentId, next);
      return SubscriptionRef.set(session, Option.some(next));
    });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId, label: name },
    session,
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const storedProject = Atom.make<EnvironmentProject | null>(null);
  const commands = createProjectEnvironmentAtoms(runtime, {
    projectAtom: (ref: ScopedProjectRef) =>
      ref.environmentId === environmentId && ref.projectId === PROJECT_ID
        ? storedProject
        : Atom.make(null),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  registry.set(
    sessions(environmentId),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationOperateScope],
    }),
  );
  return {
    createFromThreadCalls,
    publish,
    drop: SubscriptionRef.set(session, Option.none()),
    scratchAnswered: Deferred.await(scratchAnswered),
    storeProject: Effect.sync(() => registry.set(storedProject, project)),
    project,
    openScratch: () => commands.openScratch.run(registry, { environmentId, input: {} }),
    createFromThread: () =>
      commands.createFromThread.run(registry, {
        environmentId,
        input: { threadId: ThreadId.make("thread-1") },
      }),
  };
});

describe("project commands queued behind Scratch", () => {
  it.effect(
    "a project command queued behind Scratch's store wait does not run on the next session",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("project-lane-replaced");
        yield* h.publish("first");
        const opening = h.openScratch();
        yield* h.scratchAnswered;
        const turning = h.createFromThread();
        yield* h.drop;
        yield* h.publish("second");
        yield* h.storeProject;

        expect(yield* Effect.promise(() => opening)).toMatchObject({
          _tag: "Success",
          value: h.project,
        });
        const result = yield* Effect.promise(() => turning);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(Cause.squash(result.cause)).toMatchObject({
            _tag: "EnvironmentRpcUnavailableError",
            message:
              "project-lane-replaced reconnected before this ran, so it was not sent. Try again.",
          });
        }
        expect(h.createFromThreadCalls).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("a project command queued behind Scratch runs when the session did not change", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("project-lane-same");
      yield* h.publish("first");
      const opening = h.openScratch();
      yield* h.scratchAnswered;
      const turning = h.createFromThread();
      yield* h.storeProject;

      expect((yield* Effect.promise(() => opening))._tag).toBe("Success");
      expect((yield* Effect.promise(() => turning))._tag).toBe("Success");
      expect(h.createFromThreadCalls).toEqual(["first"]);
    }).pipe(Effect.scoped),
  );
});
