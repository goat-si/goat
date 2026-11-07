import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { DAY_MS, at, shell } from "./storageCleanup.testFixtures.ts";
import { LEGACY_WORKTREE_RULES, cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

describe("storage cleanup for extension status", () => {
  it.effect.each([true, false])(
    "sweeps on runtime retirement rather than live error metadata, worktreeOnDelete=%s",
    (worktreeOnDelete) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            ...LEGACY_WORKTREE_RULES,
            worktreeAfterDays: 8,
            worktreeOnDelete,
          });
          fixture.setThreads([]);
          fixture.setOpenSessionCwd(fixture.worktree);
          fixture.setDeletedThreads([
            shell({ branch: "feature", worktreePath: fixture.worktree, deletedAt: at(0) }),
          ]);
          yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "agent edit\n");
          const events = yield* Queue.unbounded<{
            readonly event: OrchestrationV2DomainEvent;
            readonly processed: Deferred.Deferred<void>;
          }>();
          yield* fixture.activate(
            Stream.fromQueue(events).pipe(
              Stream.flatMap(({ event, processed }) =>
                Stream.succeed(event).pipe(
                  Stream.concat(
                    // The next pull acknowledges that the listener handled this event.
                    Stream.fromEffect(Deferred.succeed(processed, undefined)).pipe(Stream.drain),
                  ),
                ),
              ),
            ),
          );
          yield* fixture.service.reports.pipe(
            Stream.filter((report) => report !== null),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* fixture.service.drain;
          const startupReads = fixture.snapshotReads();
          const publish = Effect.fn("StorageCleanupTest.publish")(function* (
            event: OrchestrationV2DomainEvent,
          ) {
            const processed = yield* Deferred.make<void>();
            yield* Queue.offer(events, { event, processed });
            yield* Deferred.await(processed);
            yield* fixture.service.drain;
          });
          const sessionUpdated = (
            status: "ready" | "error" | "stopped",
            text: string,
          ): OrchestrationV2DomainEvent => ({
            id: EventId.make(`event:session:${status}:${text}`),
            type: "provider-session.updated",
            threadId: ThreadId.make("thread-1"),
            occurredAt: at(0),
            payload: {
              id: ProviderSessionId.make("session-1"),
              driver: ProviderDriverKind.make("pi"),
              providerInstanceId: ProviderInstanceId.make("pi"),
              status,
              cwd: fixture.worktree,
              model: null,
              capabilities: CodexProviderCapabilitiesV2,
              extensionStatuses: text === "" ? [] : [{ key: "watch", text }],
              createdAt: at(-DAY_MS),
              updatedAt: at(0),
              lastError: status === "error" ? "Rate limited" : null,
            },
          });
          yield* publish(sessionUpdated("ready", "Watching"));
          expect(fixture.snapshotReads()).toBe(startupReads);
          for (let index = 0; index < 5; index++) {
            yield* publish(sessionUpdated("error", `Watching ${index} files`));
            expect(fixture.snapshotReads()).toBe(startupReads);
          }

          // Release removes the live entry before publishing its final error update.
          fixture.setSessionLive(false);
          yield* publish(sessionUpdated("error", ""));
          expect(fixture.snapshotReads()).toBe(startupReads + Number(worktreeOnDelete));

          yield* publish(sessionUpdated("stopped", ""));
          expect(fixture.snapshotReads()).toBe(startupReads + 2 * Number(worktreeOnDelete));

          fixture.setSessionLive(true);
          yield* publish({
            id: EventId.make("event:thread:deleted"),
            type: "thread.deleted",
            threadId: ThreadId.make("thread-1"),
            occurredAt: at(0),
            payload: { ...shell({ deletedAt: at(0) }), lastVisitedAt: null },
          });
          expect(fixture.snapshotReads()).toBe(startupReads + 3 * Number(worktreeOnDelete));
        }),
      ),
  );
});
