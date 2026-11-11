import { describe, expect, it } from "@effect/vitest";
import { CommandId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { launchActionId, newWorker } from "./goalPlan.ts";
import { remoteMarker } from "./GoalRemoteWorkers.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import {
  effectiveRuntimeMode,
  GoalOwnerAuthorityLost,
  GoalWorkerRuntime,
  REMOTE_WORKERS_NEED_FULL_ACCESS,
  workerThreadId,
} from "./GoalWorkerRuntime.ts";

import {
  confirmed,
  layerFor,
  makeSeen,
  ownerAccess,
  refused,
  type Seen,
} from "./GoalWorkerRuntime.testkit.ts";

/** The goal asks for approval-required workers; its owner holds full access. */
const careful = testGoal("goal_rt", {
  spec: testSpec({ workers: { ...testSpec().workers, runtimeMode: "approval-required" } }),
});
const worker = {
  ...newWorker(careful, 0, null),
  threadId: ThreadId.make("thread:worker"),
  state: "running" as const,
};

describe("GoalWorkerRuntime", () => {
  it("takes the lowest of the worker mode, the ceiling and the owner's current mode", () => {
    expect(effectiveRuntimeMode({ runtimeMode: "full-access" }, careful)).toBe("approval-required");
    expect(effectiveRuntimeMode({ runtimeMode: "auto-accept-edits" }, testGoal("g"))).toBe(
      "auto-accept-edits",
    );
  });

  it.effect("launches at the lowered mode, under the thread id named by the action", () => {
    const seen = makeSeen();
    return Effect.gen(function* () {
      const runtime = yield* GoalWorkerRuntime;
      const actionId = launchActionId(careful, 0, 1);
      const launched = yield* runtime.launch(
        ownerAccess("full-access"),
        {
          goal: careful,
          slot: 0,
          actionId,
          host: null,
          title: "t",
          message: "m",
          branch: "goal/test/s0-a1",
          modelSelection: careful.spec.workers.modelSelection,
        },
        confirmed(seen),
      );
      expect(seen.launches).toEqual([
        {
          modes: { runtimeMode: "approval-required", interactionMode: "default" },
          threadId: workerThreadId(actionId),
          workspace: {
            type: "worktree",
            branch: "goal/test/s0-a1",
            baseRef: "dev",
            startFromOrigin: false,
          },
        },
      ]);
      expect(launched.threadId).toBe("fleet-goal:goal:goal_rt:s0:a1:launch");
    }).pipe(Effect.provide(layerFor(seen)));
  });

  it.effect("starts a resumed attempt's worktree from the ref it resumes from", () => {
    const seen = makeSeen();
    return Effect.gen(function* () {
      yield* (yield* GoalWorkerRuntime).launch(
        ownerAccess("full-access"),
        {
          goal: careful,
          slot: 0,
          actionId: launchActionId(careful, 0, 2),
          host: null,
          title: "t",
          message: "m",
          branch: "goal/test/s0-a2",
          modelSelection: careful.spec.workers.modelSelection,
          workspace: {
            baseRef: "goat/replica/goal-goal_rt-s0-0123456789ab-1",
            startFromOrigin: false,
          },
        },
        confirmed(seen),
      );
      expect(seen.launches.map((launch) => launch.workspace)).toEqual([
        {
          type: "worktree",
          branch: "goal/test/s0-a2",
          baseRef: "goat/replica/goal-goal_rt-s0-0123456789ab-1",
          startFromOrigin: false,
        },
      ]);
    }).pipe(Effect.provide(layerFor(seen)));
  });

  it.effect(
    "refuses a follow-up to a worker above the goal's worker mode, and limits the dispatch",
    () => {
      const seen = makeSeen();
      return Effect.gen(function* () {
        const runtime = yield* GoalWorkerRuntime;
        seen.workerMode = "full-access";
        const refused = yield* runtime
          .followUp(
            ownerAccess("full-access"),
            careful,
            worker,
            "go",
            "goal:goal_rt:s0:a1:run:1:followup",
            confirmed(seen),
          )
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "runtime_mode_escalation_denied" });
        expect(seen.dispatched).toEqual([]);
        seen.workerMode = "approval-required";
        yield* runtime.followUp(
          ownerAccess("full-access"),
          careful,
          worker,
          "go",
          "goal:goal_rt:s0:a1:run:1:followup",
          confirmed(seen),
        );
        expect(seen.dispatched).toHaveLength(1);
        expect(seen.dispatched[0]!.limit).toEqual({
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        expect(seen.dispatched[0]!.command).toMatchObject({
          type: "message.dispatch",
          commandId: CommandId.make("goal:goal_rt:s0:a1:run:1:followup"),
        });
      }).pipe(Effect.provide(layerFor(seen)));
    },
  );

  it.effect("tells a missing launch from one it cannot look up", () => {
    const seen = makeSeen();
    return Effect.gen(function* () {
      const runtime = yield* GoalWorkerRuntime;
      const access = ownerAccess("full-access");
      const id = launchActionId(careful, 0, 1);
      expect(yield* runtime.findLaunched(access, careful, id, null)).toMatchObject({
        threadId: workerThreadId(id),
      });
      seen.lookup = "missing";
      expect(yield* runtime.findLaunched(access, careful, id, null)).toBeNull();
      seen.lookup = "error";
      expect((yield* runtime.findLaunched(access, careful, id, null).pipe(Effect.flip)).code).toBe(
        "orchestration_error",
      );
    }).pipe(Effect.provide(layerFor(seen)));
  });
  describe("with workers on another host (#1451)", () => {
    /** A goal on a folder elsewhere: approval-required workers under a full-access ceiling. */
    const far = testGoal("goal_far", {
      spec: testSpec({
        project: { host: null, projectId: null, cwd: "/repo" },
        workers: { ...careful.spec.workers, hostSelector: { hosts: ["mac-studio"] } },
      }),
    });
    const remoteWorker = { ...worker, host: "mac-studio" };
    const launchOn = (
      runtime: GoalWorkerRuntime["Service"],
      goal = far,
      access = ownerAccess("full-access"),
      seen?: Seen,
      confirm?: Effect.Effect<void, GoalOwnerAuthorityLost>,
    ) =>
      runtime.launch(
        access,
        {
          goal,
          slot: 0,
          actionId: launchActionId(goal, 0, 1),
          host: "mac-studio",
          title: "Worker",
          message: "m",
          branch: "goal/test/s0-a1",
          modelSelection: goal.spec.workers.modelSelection,
        },
        confirm ?? (seen === undefined ? Effect.void : confirmed(seen)),
      );
    /** The owner thread runs in full access, beyond what the goal's workers get. */
    const fullOwner = () => {
      const seen = makeSeen();
      seen.workerMode = "full-access";
      return seen;
    };
    const writes = (seen: Seen) => [
      ...seen.remoteLaunches.map(() => "goat_thread_launch"),
      ...seen.remote.map((call) => call.tool),
    ];

    it.effect(
      "launches at the goal's worker mode under a full-access session, with a marker and no launcher",
      () => {
        const seen = fullOwner();
        return Effect.gen(function* () {
          const launched = yield* launchOn(
            yield* GoalWorkerRuntime,
            far,
            ownerAccess("full-access"),
            seen,
          );
          const marker = remoteMarker(far.id, launchActionId(far, 0, 1));
          expect(seen.remoteLaunches).toHaveLength(1);
          expect(seen.remoteLaunches[0]).toMatchObject({
            host: "mac-studio",
            cwd: "/repo",
            title: "Worker" + marker,
            runtimeMode: "approval-required",
            callerRuntimeMode: "full-access",
            workspace: { type: "worktree", branch: "goal/test/s0-a1", baseRef: "dev" },
          });
          expect(seen.remoteLaunches[0]).not.toHaveProperty("launchedBy");
          expect(launched).toMatchObject({ host: "mac-studio", threadId: "thread:remote-1" });
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect(
      "never lets an owner's broader current mode raise a goal capped below full access",
      () => {
        const seen = fullOwner();
        const capped = { ...far, owner: { ...far.owner, runtimeModeCeiling: "auto" as const } };
        return Effect.gen(function* () {
          const refused = yield* launchOn(
            yield* GoalWorkerRuntime,
            capped,
            ownerAccess("auto"),
            seen,
          ).pipe(Effect.flip);
          expect(refused).toMatchObject({ message: REMOTE_WORKERS_NEED_FULL_ACCESS });
          expect(writes(seen)).toEqual([]);
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect("writes nothing when the owner's mode drops while the launch is prepared", () => {
      const seen = fullOwner();
      seen.duringWrite = () => {
        seen.workerMode = "auto";
      };
      return Effect.gen(function* () {
        const lost = yield* launchOn(
          yield* GoalWorkerRuntime,
          far,
          ownerAccess("full-access"),
          seen,
        ).pipe(Effect.flip);
        expect(lost).toMatchObject({ _tag: "GoalOwnerAuthorityLost", goalChanged: false });
        expect(writes(seen)).toEqual([]);
      }).pipe(Effect.provide(layerFor(seen)));
    });

    it.effect(
      "writes nothing when the goal changes or is deleted before the launch is sent",
      () => {
        const seen = fullOwner();
        let calls = 0;
        // The goal's own check passes once, then sees a new generation.
        const confirm = Effect.suspend(() =>
          (calls += 1) === 1
            ? Effect.void
            : Effect.fail(new GoalOwnerAuthorityLost({ message: "changed", goalChanged: true })),
        );
        return Effect.gen(function* () {
          const lost = yield* launchOn(
            yield* GoalWorkerRuntime,
            far,
            ownerAccess("full-access"),
            seen,
            confirm,
          ).pipe(Effect.flip);
          expect(lost).toMatchObject({ _tag: "GoalOwnerAuthorityLost", goalChanged: true });
          expect(writes(seen)).toEqual([]);
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect(
      "refuses a host outside the goatclaw allowlist before anything is sent, and stops when the allowlist narrows",
      () => {
        const seen = fullOwner();
        seen.profileHosts = ["other-box"];
        return Effect.gen(function* () {
          const runtime = yield* GoalWorkerRuntime;
          expect(
            yield* launchOn(runtime, far, ownerAccess("full-access"), seen).pipe(Effect.flip),
          ).toMatchObject({
            code: "capability_denied",
          });
          expect(seen.steps).not.toContain("sync mac-studio");
          seen.profileHosts = ["mac-studio"];
          seen.duringWrite = () => {
            seen.profileHosts = ["other-box"];
          };
          expect(
            yield* launchOn(runtime, far, ownerAccess("full-access"), seen).pipe(Effect.flip),
          ).toMatchObject({
            _tag: "GoalOwnerAuthorityLost",
          });
          seen.profileHosts = ["mac-studio"];
          seen.duringWrite = () => {
            seen.narrowed = true;
          };
          expect(
            yield* launchOn(runtime, far, ownerAccess("full-access"), seen).pipe(Effect.flip),
          ).toMatchObject({
            _tag: "GoalOwnerAuthorityLost",
          });
          expect(writes(seen)).toEqual([]);
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect(
      "refuses a move admitted without goatclaw once a profile is turned on, before any write",
      () => {
        const seen = fullOwner();
        return Effect.gen(function* () {
          const runtime = yield* GoalWorkerRuntime;
          const may = yield* runtime.moveAuthority(
            ownerAccess("full-access"),
            far,
            confirmed(seen),
            "other-box",
          );
          // Admitted with no policy: only the goal's own host list bounds placement.
          expect(may.allowedHosts).toEqual(["mac-studio"]);
          expect(may.permissionProfileCeiling).toBeUndefined();
          // A profile that reaches only the source is turned on before the move writes anywhere.
          seen.profileHosts = ["other-box"];
          expect(yield* may.authorize.pipe(Effect.flip)).toMatchObject({
            _tag: "RescheduleNotAllowed",
          });
          // Admitted again under that profile, the move has nowhere to go.
          const again = yield* runtime.moveAuthority(
            ownerAccess("full-access"),
            far,
            confirmed(seen),
            "other-box",
          );
          expect(again.allowedHosts).toEqual([]);
          expect(again.permissionProfileCeiling).toMatchObject({ id: "worker" });
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect("gives a drain off this machine no authority to stop the attempt it leaves", () => {
      const seen = fullOwner();
      return Effect.gen(function* () {
        const runtime = yield* GoalWorkerRuntime;
        const may = yield* runtime.moveAuthority(
          ownerAccess("full-access"),
          far,
          confirmed(seen),
          null,
        );
        expect(yield* may.authorizeSource.pipe(Effect.flip)).toMatchObject({
          _tag: "RescheduleNotAllowed",
        });
        // Its launch elsewhere is still bound by the goal's hosts and checked again before writing.
        expect(may.allowedHosts).toEqual(["mac-studio"]);
        seen.narrowed = true;
        expect(yield* may.authorize.pipe(Effect.flip)).toMatchObject({
          _tag: "RescheduleNotAllowed",
        });
        expect(writes(seen)).toEqual([]);
      }).pipe(Effect.provide(layerFor(seen)));
    });

    it.effect("finds a projectId-only goal's folder on a later page of its host's projects", () =>
      Effect.gen(function* () {
        const runtime = yield* GoalWorkerRuntime;
        const onHost = testGoal("goal_paged", {
          spec: testSpec({
            project: { host: "mac-studio", projectId: "project:120" as never, cwd: null },
          }),
        });
        expect(yield* runtime.project(onHost)).toEqual({
          cwd: "/projects/120",
          canonicalKey: null,
        });
      }).pipe(Effect.provide(layerFor(fullOwner()))),
    );

    it.effect("forwards the owner's goatclaw ceiling after syncing the destination", () => {
      const seen = fullOwner();
      seen.profileHosts = ["mac-studio"];
      return Effect.gen(function* () {
        yield* launchOn(yield* GoalWorkerRuntime, far, ownerAccess("full-access"), seen);
        expect(seen.steps).toContain("sync mac-studio");
        expect(seen.remoteLaunches[0]?.permissionProfileCeiling).toMatchObject({ id: "worker" });
      }).pipe(Effect.provide(layerFor(seen)));
    });

    it.effect(
      "keeps a launch whose answer was lost unconfirmed, finds it only by one exact marker",
      () => {
        const seen = fullOwner();
        seen.loseLaunchAnswer = true;
        return Effect.gen(function* () {
          const runtime = yield* GoalWorkerRuntime;
          const id = launchActionId(far, 0, 1);
          expect(
            yield* launchOn(runtime, far, ownerAccess("full-access"), seen).pipe(Effect.flip),
          ).toMatchObject({
            _tag: "RemoteLaunchUnconfirmed",
            host: "mac-studio",
          });
          const access = ownerAccess("full-access");
          expect(yield* runtime.findLaunched(access, far, id, "mac-studio")).toMatchObject({
            host: "mac-studio",
            threadId: "thread:remote-1",
          });
          // Absence is never proof on another host, and two threads with one marker are no answer.
          const other = launchActionId(far, 1, 1);
          expect(
            yield* runtime.findLaunched(access, far, other, "mac-studio").pipe(Effect.flip),
          ).toMatchObject({
            code: "host_unavailable",
          });
          seen.remoteThreads.push({ ...seen.remoteThreads[0]!, threadId: "thread:copy" });
          expect(
            yield* runtime.findLaunched(access, far, id, "mac-studio").pipe(Effect.flip),
          ).toMatchObject({
            code: "host_unavailable",
          });
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect(
      "sends a follow-up under the goal's ceiling, queued and keyed by its action id",
      () => {
        const seen = fullOwner();
        // The owner runs in full access now; the goal it declared is capped at auto.
        const capped = testGoal("goal_far", {
          owner: { ...careful.owner, runtimeModeCeiling: "auto" },
          spec: careful.spec,
        });
        return Effect.gen(function* () {
          yield* (yield* GoalWorkerRuntime).followUp(
            ownerAccess("auto"),
            capped,
            remoteWorker,
            "go",
            "goal:goal_far:s0:a1:run:1:followup",
            confirmed(seen),
          );
          expect(seen.remote).toEqual([
            {
              host: "mac-studio",
              tool: "goat_thread_send",
              args: {
                threadId: "thread:worker",
                message: "go",
                clientRequestId: "goal:goal_far:s0:a1:run:1:followup",
                mode: "queue",
              },
              ceiling: "auto",
            },
          ]);
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect(
      "sends no follow-up, model switch or interrupt once the owner's authority is gone",
      () => {
        const seen = fullOwner();
        return Effect.gen(function* () {
          const runtime = yield* GoalWorkerRuntime;
          seen.duringWrite = () => {
            seen.workerMode = "approval-required";
          };
          expect(
            yield* runtime
              .followUp(ownerAccess("full-access"), far, remoteWorker, "go", "f1", confirmed(seen))
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "GoalOwnerAuthorityLost" });
          expect(
            yield* runtime
              .followUp(
                ownerAccess("full-access"),
                far,
                remoteWorker,
                "go",
                "f2",
                confirmed(seen),
                { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
              )
              .pipe(Effect.flip),
          ).toMatchObject({ code: "capability_denied" });
          expect(
            yield* runtime
              .interrupt(ownerAccess("full-access"), remoteWorker, "i1", refused(seen))
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "GoalOwnerAuthorityLost" });
          expect(writes(seen)).toEqual([]);
          // A host the owner's profile no longer reaches is not interrupted from here either.
          seen.profileHosts = ["other-box"];
          expect(
            yield* runtime
              .interrupt(ownerAccess("full-access"), remoteWorker, "i3", confirmed(seen))
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "GoalOwnerAuthorityLost" });
          expect(writes(seen)).toEqual([]);
          seen.profileHosts = "off";
          // Nor through a session above what the owner's profile allows now.
          seen.profileMode = "auto";
          expect(
            yield* runtime
              .interrupt(ownerAccess("full-access"), remoteWorker, "i4", confirmed(seen))
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "GoalOwnerAuthorityLost" });
          expect(writes(seen)).toEqual([]);
          seen.profileMode = null;
          // With authority, the interrupt names its action id so a repeat is a no-op there.
          yield* runtime.interrupt(ownerAccess("full-access"), remoteWorker, "i2", confirmed(seen));
          expect(seen.remote.map((call) => [call.tool, call.args.clientRequestId])).toEqual([
            ["goat_thread_interrupt", "i2"],
          ]);
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );
  });

  describe("with an outside client owner (#493)", () => {
    const clientGoal = testGoal("goal_client", {
      owner: {
        kind: "mcp_client",
        threadId: null,
        mcpOwner: "client:session:bot",
        runtimeModeCeiling: "full-access",
      },
      spec: careful.spec,
    });
    const clientAccess = (runtime: GoalWorkerRuntime["Service"]) =>
      runtime
        .owner(clientGoal)
        .pipe(
          Effect.flatMap((access) =>
            "unavailable" in access ? Effect.die(access.unavailable) : Effect.succeed(access),
          ),
        );

    it.effect("acts as the client's live session, capped by its current goatclaw profile", () => {
      const seen = makeSeen();
      return Effect.gen(function* () {
        const runtime = yield* GoalWorkerRuntime;
        const access = yield* clientAccess(runtime);
        expect(access.scope).toMatchObject({
          thread: undefined,
          requestNamespace: "client:session:bot",
          grantedScopes: ["orchestration:operate"],
          client: { sessionId: "session:bot", access: "full-access", approvals: false },
        });
        expect(access.runtimeMode).toBe("full-access");
        // A narrower profile now lowers what the goal may do, below the ceiling it stored.
        seen.profileMode = "auto-accept-edits";
        expect(yield* runtime.owner(clientGoal)).toMatchObject({
          runtimeMode: "auto-accept-edits",
        });
        // A revoked or expired session, or a goal naming none, leaves nothing to act as.
        seen.liveClients.clear();
        expect(yield* runtime.owner(clientGoal)).toHaveProperty("unavailable");
        expect(
          yield* runtime.owner({ ...clientGoal, owner: { ...clientGoal.owner, mcpOwner: null } }),
        ).toHaveProperty("unavailable");
      }).pipe(Effect.provide(layerFor(seen)));
    });

    it.effect(
      "sends as no thread, and confirms after reading the target, right before sending",
      () => {
        const seen = makeSeen();
        return Effect.gen(function* () {
          const runtime = yield* GoalWorkerRuntime;
          const access = yield* clientAccess(runtime);
          yield* runtime.followUp(
            access,
            clientGoal,
            worker,
            "go",
            "goal:c:followup",
            confirmed(seen),
          );
          expect(seen.steps).toEqual(["read", "confirm", "dispatch"]);
          expect(seen.dispatched[0]!.command).not.toHaveProperty("senderThreadId");
          seen.steps.length = 0;
          yield* runtime.interrupt(access, worker, "goal:c:interrupt", confirmed(seen));
          expect(seen.steps).toEqual(["read", "confirm", "dispatch"]);
          expect(seen.dispatched[1]!.command).toMatchObject({ type: "run.interrupt" });
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect(
      "launches on another host as the client, with no launcher thread, and stops when its session is revoked meanwhile (#1451)",
      () => {
        const seen = makeSeen();
        const far = {
          ...clientGoal,
          spec: testSpec({
            project: { host: null, projectId: null, cwd: "/repo" },
            workers: { ...clientGoal.spec.workers, hostSelector: { hosts: ["mac-studio"] } },
          }),
        };
        const request = (attempt: number) => ({
          goal: far,
          slot: 0,
          actionId: launchActionId(far, 0, attempt),
          host: "mac-studio",
          title: "Worker",
          message: "m",
          branch: "goal/test/s0-a" + attempt,
          modelSelection: far.spec.workers.modelSelection,
        });
        return Effect.gen(function* () {
          const runtime = yield* GoalWorkerRuntime;
          const access = yield* clientAccess(runtime);
          yield* runtime.launch(access, request(1), confirmed(seen));
          expect(seen.remoteLaunches).toHaveLength(1);
          expect(seen.remoteLaunches[0]).not.toHaveProperty("launchedBy");
          // After a restart its thread is found by the marker alone, as no watch exists.
          expect(
            yield* runtime.findLaunched(access, far, launchActionId(far, 0, 1), "mac-studio"),
          ).toMatchObject({ threadId: "thread:remote-1" });
          seen.duringWrite = () => seen.liveClients.clear();
          expect(
            yield* runtime.launch(access, request(2), confirmed(seen)).pipe(Effect.flip),
          ).toMatchObject({
            _tag: "GoalOwnerAuthorityLost",
          });
          expect(seen.remoteLaunches).toHaveLength(1);
        }).pipe(Effect.provide(layerFor(seen)));
      },
    );

    it.effect("hands nothing to the orchestrator when the last confirm refuses", () => {
      const seen = makeSeen();
      return Effect.gen(function* () {
        const runtime = yield* GoalWorkerRuntime;
        const access = yield* clientAccess(runtime);
        const followUp = yield* runtime
          .followUp(access, clientGoal, worker, "go", "goal:c:followup", refused(seen))
          .pipe(Effect.flip);
        expect(followUp._tag).toBe("GoalOwnerAuthorityLost");
        const interrupt = yield* runtime
          .interrupt(access, worker, "goal:c:interrupt", refused(seen))
          .pipe(Effect.flip);
        expect(interrupt._tag).toBe("GoalOwnerAuthorityLost");
        expect(seen.steps).toEqual(["read", "confirm", "read", "confirm"]);
        const launch = yield* runtime
          .launch(
            access,
            {
              goal: clientGoal,
              slot: 0,
              actionId: launchActionId(clientGoal, 0, 1),
              host: null,
              title: "t",
              message: "m",
              branch: "goal/test/s0-a1",
              modelSelection: clientGoal.spec.workers.modelSelection,
            },
            refused(seen),
          )
          .pipe(Effect.flip);
        expect(launch).toMatchObject({ _tag: "GoalOwnerAuthorityLost", message: "revoked" });
        expect(seen.launches).toEqual([]);
        expect(seen.dispatched).toEqual([]);
      }).pipe(Effect.provide(layerFor(seen)));
    });
  });
});
