import { assert, it } from "@effect/vitest";
import { RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { makeTestRelay, NOW, shell, THREAD_ID } from "./AgentAwarenessRelay.testkit.ts";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

it.effect("catches up a waiting child after startup and after a relay relink", () =>
  Effect.gen(function* () {
    const id = ThreadId.make("waiting-child");
    const child = shell({
      id,
      creationSource: "mcp",
      createdBy: "agent",
      activityRunStatus: "running",
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: THREAD_ID,
        relationshipToParent: "subagent",
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("child-request"),
        kind: "command",
        createdAt: DateTime.makeUnsafe(NOW),
      },
    });
    const current = yield* Ref.make(child);
    const activeSubagents = [id];
    const { relay, secrets, publications } = yield* makeTestRelay({
      activeSubagents,
      readShell: (threadId) => (threadId === id ? Ref.get(current) : Effect.succeed(shell())),
    });
    yield* relay.start();
    yield* TestClock.adjust("1 second");
    yield* relay.drain;
    assert.equal(publications.length, 1);
    assert.equal(publications[0]?.state?.phase, "waiting_for_approval");
    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    yield* relay.drain;
    assert.equal(publications.length, 2);
    assert.equal(publications[1]?.state?.phase, "waiting_for_approval");
    assert.equal(publications[1]?.state?.updatedAt, publications[0]?.state?.updatedAt);
    activeSubagents.pop();
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    yield* relay.drain;
    assert.equal(publications[2]?.state?.phase, "running");
  }).pipe(Effect.scoped),
);

it.effect("reaches waiting children beyond the first catch-up page", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 129 }, (_, index) =>
      ThreadId.make(`child-${String(index).padStart(3, "0")}`),
    );
    const last = ids[128]!;
    const { relay, publications } = yield* makeTestRelay({
      activeSubagents: ids,
      readShell: (id) =>
        Effect.succeed(
          id === THREAD_ID
            ? shell()
            : shell({
                id,
                creationSource: "mcp",
                activityRunStatus: "running",
                lineage: {
                  rootThreadId: THREAD_ID,
                  parentThreadId: THREAD_ID,
                  relationshipToParent: "subagent",
                },
                pendingRuntimeRequest:
                  id === last
                    ? {
                        id: RuntimeRequestId.make("later-page"),
                        kind: "command",
                        createdAt: DateTime.makeUnsafe(NOW),
                      }
                    : null,
              }),
        ),
    });
    yield* relay.start();
    yield* TestClock.adjust("1 second");
    yield* relay.drain;
    assert.equal(publications.length, 1);
    assert.equal(publications[0]?.state?.phase, "waiting_for_approval");
  }).pipe(Effect.scoped),
);

it.effect("does not notify for a non-blocking question or a provider-native child", () =>
  Effect.gen(function* () {
    const id = ThreadId.make("ignored-child");
    const base = shell({
      id,
      creationSource: "mcp",
      createdBy: "agent",
      activityRunStatus: "running",
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: THREAD_ID,
        relationshipToParent: "subagent",
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("question"),
        kind: "user_input",
        blocking: false,
        createdAt: DateTime.makeUnsafe(NOW),
      },
    });
    const current = yield* Ref.make(base);
    const { relay, publications } = yield* makeTestRelay({
      readShell: (threadId) => (threadId === id ? Ref.get(current) : Effect.succeed(shell())),
    });
    yield* relay.publishThread(id);
    yield* Ref.set(current, {
      ...base,
      creationSource: "provider",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("approval"),
        kind: "command",
        createdAt: DateTime.makeUnsafe(NOW),
      },
    });
    yield* relay.publishThread(id);
    assert.equal(publications.length, 0);
  }),
);

it.effect("preserves a child's alert identity across parent projection changes", () =>
  Effect.gen(function* () {
    const id = ThreadId.make("child-stable");
    const child = shell({
      id,
      creationSource: "mcp",
      createdBy: "agent",
      activityRunStatus: "running",
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: THREAD_ID,
        relationshipToParent: "subagent",
      },
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("child-stable-request"),
        kind: "command",
        createdAt: DateTime.makeUnsafe(NOW),
      },
    });
    const parent = yield* Ref.make(shell());
    const { relay, publications } = yield* makeTestRelay({
      readShell: (threadId) => (threadId === id ? Effect.succeed(child) : Ref.get(parent)),
    });
    yield* relay.publishThread(id);
    yield* Ref.set(
      parent,
      shell({ title: "Renamed", updatedAt: DateTime.makeUnsafe("2026-09-04T12:10:00.000Z") }),
    );
    yield* relay.publishThread(THREAD_ID);
    assert.equal(publications.length, 2);
    assert.equal(publications[1]?.state?.threadTitle, "Renamed");
    assert.equal(publications[1]?.state?.updatedAt, publications[0]?.state?.updatedAt);
    yield* relay.publishThread(id);
    assert.equal(publications.length, 2);
  }),
);
