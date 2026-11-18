import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type FilesystemBrowseEntry, WS_METHODS } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createFilesystemEnvironmentAtoms } from "./filesystem.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";
import {
  QUERY_ENVIRONMENT,
  QUERY_RPC_SESSION,
  makeEnvironmentQueryHarness,
  readEnvironmentQuery,
} from "./runtimeTestSupport.ts";

describe("cached environment lifecycle", () => {
  it.effect.each([
    { completedTtlMs: undefined, subscriptions: 2 },
    { completedTtlMs: 60_000, subscriptions: 1 },
  ])(
    "reopening a completed subscription subscribes $subscriptions time(s) with completedTtlMs $completedTtlMs",
    ({ completedTtlMs, subscriptions }) =>
      Effect.gen(function* () {
        let subscribed = 0;
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream: (_environmentId: EnvironmentId, source: Stream.Stream<unknown>) => source,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        );
        const family = createEnvironmentSubscriptionAtomFamily(runtime, {
          label: "test.completed-subscription",
          subscribe: () =>
            Stream.suspend(() => {
              subscribed += 1;
              return Stream.make({ complete: false }, { complete: true });
            }),
          completeWhen: (value) => value.complete,
          idleTtlMs: 0,
          ...(completedTtlMs === undefined ? {} : { completedTtlMs }),
        });
        const atom = family({ environmentId: QUERY_ENVIRONMENT.environmentId, input: undefined });
        // Flushed after each close: idle removals have run by the time a user reopens a row.
        const scheduled: Array<() => void> = [];
        const registry = AtomRegistry.make({
          scheduleTask: (task) => {
            scheduled.push(task);
            return () => undefined;
          },
        });
        const open = Effect.gen(function* () {
          const settled = yield* Deferred.make<boolean>();
          const unsubscribe = registry.subscribe(
            atom,
            (result) => {
              if (AsyncResult.isSuccess(result) && !result.waiting) {
                Deferred.doneUnsafe(settled, Exit.succeed(result.value.complete));
              }
            },
            { immediate: true },
          );
          const complete = yield* Deferred.await(settled);
          unsubscribe();
          for (const task of scheduled.splice(0)) task();
          return complete;
        });

        expect(yield* open).toBe(true);
        expect(yield* open).toBe(true);
        expect(subscribed).toBe(subscriptions);
        registry.dispose();
      }),
  );
  it.effect("filesystem browse lists the directory afresh when a picker reopens it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeEnvironmentQueryHarness(Effect.void);
        const entry = (name: string): FilesystemBrowseEntry => ({
          name,
          fullPath: `/tmp/t3-11476-repro/${name}`,
        });
        let onDisk = [entry("existing")];
        const client = {
          [WS_METHODS.filesystemBrowse]: () =>
            Effect.sync(() => ({ parentPath: "/tmp/t3-11476-repro/", entries: onDisk })),
        } as unknown as RpcSession.RpcSession["client"];
        yield* SubscriptionRef.set(
          harness.supervisorSession,
          Option.some({ ...QUERY_RPC_SESSION, client }),
        );
        const atom = createFilesystemEnvironmentAtoms(harness.runtime).browse({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { partialPath: "/tmp/t3-11476-repro/" },
        });
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        // Stale-while-revalidate refreshes from a task on the registry scheduler;
        // queue behind it so the read sees the revalidation instead of racing it.
        const afterScheduledTasks = Effect.callback<void>((resume) => {
          registry.schedulerAsync.makeDispatcher().scheduleTask(() => resume(Effect.void), 0);
        });
        const listNames = afterScheduledTasks.pipe(
          Effect.andThen(readEnvironmentQuery(registry, atom)),
          Effect.map((result) => result.entries.map((browseEntry) => browseEntry.name)),
        );

        const closePicker = registry.mount(atom);
        expect(yield* listNames).toEqual(["existing"]);
        closePicker();
        // A closed picker stays closed past the registry's scheduled node
        // removal; a remount within the same tick keeps the live node.
        yield* afterScheduledTasks;

        onDisk = [entry("created-externally"), entry("existing")];
        registry.mount(atom);
        expect(yield* listNames).toEqual(["created-externally", "existing"]);
      }),
    ),
  );
});
