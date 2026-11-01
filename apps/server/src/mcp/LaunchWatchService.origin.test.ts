import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  launcher,
  target,
  run1,
  run2,
  makeWorld,
  withService,
  tempDir,
  watchRemote,
  remoteItem,
  remoteRead,
} from "./LaunchWatchService.testkit.ts";

const external = {
  owner: "client:bot-a",
  host: "box",
  threadId: target,
  projectId: null,
  title: "Fix the flake",
  runId: run1,
  ceiling: "full-access" as const,
  route: { notifyWebhook: true, webhookTarget: null },
};

describe("LaunchWatchService origin routing", () => {
  it.effect("resumed managed watch uses its saved origin after app attach", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const origin = EnvironmentId.make("managed-owner");
      const waiting = yield* Deferred.make<void>();
      world.hostCall = (call) =>
        call.tool === "goat_thread_wait"
          ? Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.die(new Error(`unexpected ${call.tool}`));
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            launcherThreadId: launcher,
            host: "box",
            threadId: target,
            projectId: null,
            title: "Remote",
            runId: run1,
            sourceEnvironmentId: origin,
          });
          yield* Deferred.await(waiting);
        }),
      );
      world.hostCall = (call) =>
        call.tool === "goat_thread_wait"
          ? Effect.succeed({ threadId: target, runId: run1, status: "completed", timedOut: false })
          : Effect.succeed(remoteRead({ itemCount: 1, items: [remoteItem(0, run1, "Done.")] }));
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          const wake = yield* Queue.take(world.delivered);
          expect(wake.text).toContain("Done.");
          const saved = yield* service.find({
            launcherThreadId: launcher,
            host: "box",
            threadId: target,
          });
          expect(saved?.sourceEnvironmentId).toBe(origin);
          expect(saved?.pendingRuns).toEqual([]);
        }),
      );
      expect(world.hostCalls.every(({ call }) => call.environmentId === origin)).toBe(true);
      expect(world.deliveredLog).toHaveLength(1);
    }),
  );
  it.effect(
    "legacy watch accepts an alternate database answer before Gone and a truly missing thread becomes Gone",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        world.hostCall = (call) =>
          call.tool === "goat_thread_wait"
            ? Effect.succeed({
                threadId: target,
                runId: run1,
                status: "completed",
                timedOut: false,
              })
            : Effect.succeed(
                remoteRead({ itemCount: 1, items: [remoteItem(0, run1, "From managed.")] }),
              );
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* watchRemote(service, run1);
            const wake = yield* Queue.take(world.delivered);
            expect(wake.text).toContain("From managed.");
            expect(wake.text).not.toContain("can no longer be followed");
          }),
        );
        expect(world.hostCalls.every(({ call }) => call.environmentId === null)).toBe(true);

        const missing = yield* makeWorld;
        const missingDir = yield* tempDir;
        missing.hostCall = () =>
          Effect.fail(
            new SshRemoteDispatch.SshRemoteDispatchError({
              reason: "remote_refused",
              remoteCode: "thread_not_found",
              message: "missing",
            }),
          );
        yield* withService(missing, missingDir, (service) =>
          Effect.gen(function* () {
            yield* watchRemote(service, run1);
            const wake = yield* Queue.take(missing.delivered);
            expect(wake.text).toContain("can no longer be followed");
          }),
        );
      }),
  );
  it.effect(
    "keeps the first remote watch origin and pending run on a conflicting registration",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const started = yield* Deferred.make<SshRemoteDispatch.SshHostToolCall>();
        world.hostCall = (call) =>
          Deferred.succeed(started, call).pipe(Effect.andThen(Effect.never));
        const baseDir = yield* tempDir;
        const firstId = EnvironmentId.make("managed-owner");
        const secondId = EnvironmentId.make("app-owner");
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            const key = { launcherThreadId: launcher, host: "box", threadId: target } as const;
            const first = yield* service.register({
              ...key,
              projectId: null,
              title: "Remote",
              runId: run1,
              sourceEnvironmentId: firstId,
            });
            expect(first.sourceEnvironmentId).toBe(firstId);
            const refusal = yield* service
              .register({
                ...key,
                projectId: null,
                title: "Other",
                runId: run2,
                sourceEnvironmentId: secondId,
              })
              .pipe(Effect.flip);
            expect(refusal).toMatchObject({ code: "watch_origin_conflict" });
            const saved = yield* service.find(key);
            expect(saved?.sourceEnvironmentId).toBe(firstId);
            expect(saved?.pendingRuns).toEqual([run1]);
            expect((yield* Deferred.await(started)).environmentId).toBe(firstId);
          }),
        );
      }),
  );

  it.effect("fills a legacy remote watch origin on re-registration", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const firstId = EnvironmentId.make("managed-owner");
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          const key = { launcherThreadId: launcher, host: "box", threadId: target } as const;
          yield* service.register({ ...key, projectId: null, title: null, runId: null });
          const filled = yield* service.register({
            ...key,
            projectId: null,
            title: null,
            runId: null,
            sourceEnvironmentId: firstId,
          });
          expect(filled.sourceEnvironmentId).toBe(firstId);
        }),
      );
    }),
  );
  it.effect("refuses a conflicting launcherless origin without moving pending runs", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const started = yield* Deferred.make<SshRemoteDispatch.SshHostToolCall>();
      world.hostCall = (call) => Deferred.succeed(started, call).pipe(Effect.andThen(Effect.never));
      const baseDir = yield* tempDir;
      const firstId = EnvironmentId.make("managed-owner");
      const secondId = EnvironmentId.make("app-owner");
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          const first = yield* service.watchExternal({ ...external, sourceEnvironmentId: firstId });
          expect(first?.sourceEnvironmentId).toBe(firstId);
          const refused = yield* service
            .watchExternal({ ...external, sourceEnvironmentId: secondId })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({ code: "watch_origin_conflict" });
          const saved = yield* service.find({
            launcherThreadId: null,
            owner: "client:bot-a",
            host: "box",
            threadId: target,
          });
          expect(saved?.sourceEnvironmentId).toBe(firstId);
          expect(saved?.pendingRuns).toEqual([run1]);
          expect((yield* Deferred.await(started)).environmentId).toBe(firstId);
        }),
      );
    }),
  );
});
