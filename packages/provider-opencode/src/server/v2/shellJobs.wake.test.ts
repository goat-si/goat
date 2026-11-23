import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { ActiveTurn, ThreadState, Wake } from "./adapterState.ts";
import { makeShellJobs, type ShellJobDeps } from "./shellJobs.ts";

it.effect(
  "a held shell accepts wait marks, and its early completion is not revived on replay",
  () =>
    Effect.gen(function* () {
      const wake = {
        events: [
          { type: "session.tool.success", data: { id: "tool", metadata: { shellID: "sh_shell" } } },
        ],
        awaited: new Set<string>(),
        ended: new Map(),
        children: new Set(),
      } as unknown as Wake;
      const state = {
        wakes: [wake],
        sessionId: "session",
        directory: "/work",
        reports: new Map(),
        providerThread: { pendingBackgroundTasks: [] },
      } as unknown as ThreadState;
      const turn = {
        tools: new Map([["tool", { name: "shell", input: { command: "test" } }]]),
      } as unknown as ActiveTurn;
      const statuses: string[] = [];
      const deps = {
        sessionsOf: () => [state],
        lock: yield* Semaphore.make(1),
        connection: () => ({
          client: {
            shell: { output: () => Effect.succeed({ data: { output: "", cursor: 0, size: 0 } }) },
          },
        }),
        emitTool: (_state: unknown, _turn: unknown, _id: unknown, status: string) =>
          Effect.sync(() => {
            statuses.push(status);
          }),
        syncRosterAncestors: () => Effect.void,
      } as unknown as ShellJobDeps;
      const jobs = makeShellJobs(deps);
      assert.deepEqual(yield* jobs.awaitTasks(state, ["sh_shell", "other"], true), {
        matched: ["sh_shell"],
      });
      assert.isTrue(wake.awaited.has("sh_shell"));
      yield* jobs.onReport(state, "report", {
        text: "done",
        metadata: { source: "shell", shellID: "sh_shell", state: "completed" },
      });
      assert.deepEqual(yield* jobs.awaitTasks(state, ["sh_shell"], true), { matched: [] });
      yield* jobs.replay(
        wake,
        jobs
          .onToolSuccess(state, turn, { id: "tool", metadata: { shellID: "sh_shell" } })
          .pipe(Effect.asVoid),
      );
      assert.deepEqual(statuses, ["completed"]);
      assert.isFalse(jobs.owes(state));
    }),
);
