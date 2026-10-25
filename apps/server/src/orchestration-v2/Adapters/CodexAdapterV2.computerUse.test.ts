import { assert, describe, it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import { fixture, layerAdapterTest, spawnChild } from "./CodexAdapterV2.attachment.testkit.ts";
import { makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

describe("Codex computer use attachment", () => {
  it.effect.each(["managed", "user", "override"] as const)(
    "reloads a live thread when computer use attaches, its control changes after Stop, or it detaches, unless the user defines it (%s)",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture(`cua-live-${mode}`);
          const withCua = (control: string) => ({
            ...f.config,
            cuaDriver: f.driver(control),
            ...(mode === "override" ? { cuaDriverOverridesUserConfig: true } : {}),
          });
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          // Turn 1 runs before computer use is enabled.
          yield* f.turnStart(3, 1, false);
          f.turnCompleted(1);
          let id = 4;
          // Unless the decision overrides it, the user's config is read once for the directory.
          if (mode !== "override") {
            f.entries.push(
              {
                type: "expect_outbound",
                frame: {
                  id,
                  method: "config/read",
                  params: { cwd: "/workspace", includeLayers: false },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  id,
                  result: {
                    config: {
                      mcp_servers:
                        mode === "user" ? { "cua-driver": { command: "/opt/my/cua-driver" } } : {},
                    },
                    origins: {},
                  },
                },
              },
            );
            id++;
          }
          if (mode === "user") {
            // The user's own cua-driver wins: no reload and no instructions.
            for (const ordinal of [2, 3, 4]) {
              yield* f.turnStart(id++, ordinal, false);
              f.turnCompleted(ordinal);
            }
          } else {
            // Turn 2 attaches control A; turn 3 runs under control B, minted after a Stop.
            const turns = [
              [2, f.managed("control:a"), true],
              [3, f.managed("control:b"), true],
              // Turn 4: disabled again. The managed entry is switched off, not left behind.
              [4, { ...f.managed("control:b"), enabled: false }, false],
            ] as const;
            for (const [ordinal, cua, computerUse] of turns) {
              id = f.reload(id, cua);
              yield* f.turnStart(id++, ordinal, computerUse);
              f.turnCompleted(ordinal);
            }
          }
          const replay = yield* f.open;
          for (const [ordinal, attachment] of [
            f.config,
            withCua("control:a"),
            withCua("control:b"),
            f.config,
          ].entries()) {
            yield* sessions.set(attachment);
            yield* replay.startTurn(ordinal + 1);
            yield* replay.terminal;
          }
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            mode === "user"
              ? [undefined]
              : [
                  undefined,
                  f.managed("control:a"),
                  f.managed("control:b"),
                  { ...f.managed("control:b"), enabled: false },
                ],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "keeps a thread with a running turn subscribed, tells the turn why, and reloads at the next idle turn (#1564)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("cua-running-turn");
          const withCua = (control: string) => ({
            ...f.config,
            cuaDriver: f.driver(control),
            cuaDriverOverridesUserConfig: true,
          });
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(withCua("control:a"));
          f.start(f.managed("control:a"));
          // Turn 1 is still running when the control changes. Input sent to it (turn 2) goes
          // straight to turn/start with the deferral note: no unsubscribe can drop its events.
          yield* f.turnStart(3, 1, true);
          yield* f.turnStart(4, 2, true, true);
          f.turnCompleted(1);
          f.turnCompleted(2);
          // Once Codex reports the thread idle, the new control reaches it through a reload.
          yield* f.turnStart(f.reload(5, f.managed("control:b")), 3, true);
          f.turnCompleted(3);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* sessions.set(withCua("control:b"));
          yield* replay.startTurn(2);
          yield* replay.terminal;
          yield* replay.terminal;
          yield* replay.startTurn(3);
          yield* replay.terminal;
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            [f.managed("control:a"), f.managed("control:b")],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect.each([
    { case: "still running", flags: [] },
    { case: "waiting on an approval", flags: ["waitingOnApproval"] },
  ] as const)(
    "defers the reload while a completed turn's subagent is $case, then reloads once Codex reports it idle (#1564)",
    ({ case: name, flags }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = `cua-child-${flags.length === 0 ? "running" : "waiting"}`;
          const child = `${root}-agent`;
          const f = fixture(root);
          const withCua = (control: string) => ({
            ...f.config,
            cuaDriver: f.driver(control),
            cuaDriverOverridesUserConfig: true,
          });
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(withCua("control:a"));
          f.start(f.managed("control:a"));
          yield* f.turnStart(3, 1, true);
          spawnChild(f, root, child);
          f.status(child, "active", flags);
          f.turnCompleted(1);
          // Turn 2 under a new control: Codex still reports the child busy, so nothing reloads.
          yield* f.turnStart(4, 2, true, true);
          f.status(child, "idle");
          f.turnCompleted(2);
          yield* f.turnStart(f.reload(5, f.managed("control:b"), [root, child]), 3, true);
          f.turnCompleted(3);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          yield* sessions.set(withCua("control:b"));
          yield* replay.startTurn(2);
          yield* replay.terminal;
          yield* replay.startTurn(3);
          yield* replay.terminal;
          assert.isString(name);
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            [f.managed("control:a"), f.managed("control:b")],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("never reloads while Codex has not reported a subagent thread's status (#1564)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "cua-child-unreported";
        const child = `${root}-agent`;
        const f = fixture(root);
        const withCua = (control: string) => ({
          ...f.config,
          cuaDriver: f.driver(control),
          cuaDriverOverridesUserConfig: true,
        });
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(withCua("control:a"));
        f.start(f.managed("control:a"));
        yield* f.turnStart(3, 1, true);
        spawnChild(f, root, child);
        f.turnCompleted(1);
        // Unknown is treated as busy: each later turn carries the note and nothing reloads.
        yield* f.turnStart(4, 2, true, true);
        f.turnCompleted(2);
        yield* f.turnStart(5, 3, true, true);
        f.turnCompleted(3);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* sessions.set(withCua("control:b"));
        for (const ordinal of [2, 3]) {
          yield* replay.startTurn(ordinal);
          yield* replay.terminal;
        }
        assert.deepEqual(
          replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
          [f.managed("control:a")],
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
  it.effect(
    "keeps a just-started turn busy when the previous turn's idle arrives late (#1564)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("cua-late-idle");
          const withCua = (control: string) => ({
            ...f.config,
            cuaDriver: f.driver(control),
            cuaDriverOverridesUserConfig: true,
          });
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(withCua("control:a"));
          f.start(f.managed("control:a"));
          yield* f.turnStart(3, 1, true);
          // Codex admits turn 2 before publishing turn 1's idle; turn 2's own notifications come later.
          yield* f.turnStart(4, 2, true);
          const turnTwoStarted = f.entries.splice(-2);
          f.turnCompleted(1);
          // Turn 3 under a new control must not reload: turn 2 is running.
          yield* f.turnStart(5, 3, true, true);
          f.entries.push(...turnTwoStarted);
          f.turnCompleted(2);
          f.turnCompleted(3);
          yield* f.turnStart(f.reload(6, f.managed("control:b")), 4, true);
          f.turnCompleted(4);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.startTurn(2);
          yield* replay.terminal;
          yield* sessions.set(withCua("control:b"));
          yield* replay.startTurn(3);
          yield* replay.terminal;
          yield* replay.terminal;
          yield* replay.startTurn(4);
          yield* replay.terminal;
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            [f.managed("control:a"), f.managed("control:b")],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );
  it.effect(
    "defers the reload while an active goal can start a continuation turn on its own (#1564)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "cua-goal-continuation";
          const f = fixture(root);
          const withCua = (control: string) => ({
            ...f.config,
            cuaDriver: f.driver(control),
            cuaDriverOverridesUserConfig: true,
          });
          const goal = (tokensUsed: number, status = "active") => ({
            threadId: root,
            objective: "turn-1",
            status,
            tokenBudget: null,
            tokensUsed,
            timeUsedSeconds: 3,
            createdAt: 1782622440,
            updatedAt: 1782622450,
          });
          const request = (id: number, method: string, params: unknown, result: unknown) =>
            f.entries.push(
              { type: "expect_outbound", frame: { id, method, params } },
              { type: "emit_inbound", frame: { id, result } },
            );
          const notice = (method: string, params: unknown) =>
            f.entries.push({ type: "emit_inbound", frame: { method, params } });
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(withCua("control:a"));
          f.start(f.managed("control:a"));
          request(3, "thread/goal/get", { threadId: root }, { goal: null });
          request(
            4,
            "thread/goal/set",
            { threadId: root, objective: "turn-1", status: "paused" },
            { goal: goal(0, "paused") },
          );
          yield* f.turnStart(5, 1, true);
          request(6, "thread/goal/set", { threadId: root, status: "active" }, { goal: goal(0) });
          notice("thread/goal/updated", { threadId: root, turnId: "turn-1", goal: goal(0) });
          f.turnCompleted(1);
          notice("thread/goal/updated", { threadId: root, turnId: null, goal: goal(11) });
          // Codex has started a continuation turn but not yet published it; the person's input
          // folds into it, so a new control must wait instead of reloading under it.
          f.goalGet(7, root, { result: { goal: goal(11) } });
          yield* f.turnStart(8, 3, true, true);
          f.entries.splice(-3);
          f.entries.push({
            type: "emit_inbound",
            frame: {
              id: 8,
              result: { turn: makeCodexReplayTurn({ id: "turn-auto", status: "inProgress" }) },
            },
          });
          f.status(root, "active");
          notice("turn/started", {
            threadId: root,
            turn: makeCodexReplayTurn({ id: "turn-auto", status: "inProgress" }),
          });
          const replay = yield* f.open;
          yield* replay.startTurn(1, "/goal turn-1");
          while ((yield* replay.goalTokens) !== 11) {}
          yield* TestClock.adjust("5 seconds");
          yield* replay.terminal;
          yield* sessions.set(withCua("control:b"));
          yield* replay.startTurn(3);
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            [f.managed("control:a")],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );
  const childGoal = (child: string, status: string, updatedAt: number) => ({
    threadId: child,
    objective: "Keep working",
    status,
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 3,
    createdAt: 1782622440,
    updatedAt,
  });
  // A subagent's goal notifications do not hold the parent's run, so these tests need no clock.
  const childGoalScenario = (root: string) =>
    Effect.gen(function* () {
      const child = root + "-agent";
      const f = fixture(root);
      const withCua = (control: string) => ({
        ...f.config,
        cuaDriver: f.driver(control),
        cuaDriverOverridesUserConfig: true,
      });
      const goalNotice = (goal: ReturnType<typeof childGoal> | null) =>
        f.entries.push({
          type: "emit_inbound",
          frame:
            goal === null
              ? { method: "thread/goal/cleared", params: { threadId: child } }
              : { method: "thread/goal/updated", params: { threadId: child, turnId: null, goal } },
        });
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(withCua("control:a"));
      f.start(f.managed("control:a"));
      yield* f.turnStart(3, 1, true);
      spawnChild(f, root, child);
      f.status(child, "active");
      return { f, child, goalNotice, withCua, sessions };
    });

  it.effect(
    "asks Codex for goals before reloading, so a new same-second subagent goal still defers it (#1564)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "cua-child-goal";
          const { f, child, goalNotice, withCua, sessions } = yield* childGoalScenario(root);
          // Codex stamps goals to the second: a finished goal and the next one can tie.
          goalNotice(childGoal(child, "complete", 1782622450));
          goalNotice(childGoal(child, "active", 1782622450));
          // The child's new goal has started a turn whose active status Codex has not published.
          f.status(child, "idle");
          f.turnCompleted(1);
          f.goalGet(4, root, { result: { goal: null } });
          f.goalGet(5, child, { result: { goal: childGoal(child, "active", 1782622450) } });
          yield* f.turnStart(6, 2, true, true);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          yield* sessions.set(withCua("control:b"));
          yield* replay.startTurn(2);
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            [f.managed("control:a")],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "reloads after a goal clear even when an older active goal update arrives after it (#1564)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "cua-child-goal-cleared";
          const { f, child, goalNotice, withCua, sessions } = yield* childGoalScenario(root);
          goalNotice(childGoal(child, "active", 100));
          goalNotice(null);
          // Accounting Codex queued before the clear, published after it.
          goalNotice(childGoal(child, "active", 101));
          f.status(child, "idle");
          f.turnCompleted(1);
          yield* f.turnStart(f.reload(4, f.managed("control:b"), [root, child]), 2, true);
          f.turnCompleted(2);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          yield* sessions.set(withCua("control:b"));
          yield* replay.startTurn(2);
          yield* replay.terminal;
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            [f.managed("control:a"), f.managed("control:b")],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "defers the reload when a subagent reports active while its goal is read, even once the goal clears (#1564)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "cua-active-during-goal-read";
          const { f, child, goalNotice, withCua, sessions } = yield* childGoalScenario(root);
          goalNotice(childGoal(child, "active", 100));
          f.status(child, "idle");
          f.turnCompleted(1);
          f.entries.push({
            type: "expect_outbound",
            frame: { id: 4, method: "thread/goal/get", params: { threadId: root } },
          });
          // The child's continuation, admitted before the read, reports active during it; then its
          // goal clears, which does not stop the running turn.
          f.status(child, "active");
          f.entries.push({
            type: "emit_inbound",
            frame: {
              method: "turn/started",
              params: {
                threadId: child,
                turn: makeCodexReplayTurn({ id: "child-auto", status: "inProgress" }),
              },
            },
          });
          goalNotice(null);
          f.entries.push({ type: "emit_inbound", frame: { id: 4, result: { goal: null } } });
          f.goalGet(5, child, { result: { goal: null } });
          yield* f.turnStart(6, 2, true, true);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          yield* sessions.set(withCua("control:b"));
          yield* replay.startTurn(2);
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            [f.managed("control:a")],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("reloads once a failed subagent is left in systemError (#1564)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "cua-child-failed";
        const child = root + "-agent";
        const f = fixture(root);
        const withCua = (control: string) => ({
          ...f.config,
          cuaDriver: f.driver(control),
          cuaDriverOverridesUserConfig: true,
        });
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(withCua("control:a"));
        f.start(f.managed("control:a"));
        yield* f.turnStart(3, 1, true);
        spawnChild(f, root, child);
        f.status(child, "active");
        // Codex keeps a loaded child whose turn failed in systemError until it runs again.
        f.status(child, "systemError");
        f.turnCompleted(1);
        yield* f.turnStart(f.reload(4, f.managed("control:b"), [root, child]), 2, true);
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* sessions.set(withCua("control:b"));
        yield* replay.startTurn(2);
        yield* replay.terminal;
        assert.deepEqual(
          replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
          [f.managed("control:a"), f.managed("control:b")],
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("waits for a root left in systemError to run a turn before reloading it (#1569)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("cua-root-failed");
        const withCua = (control: string) => ({
          ...f.config,
          cuaDriver: f.driver(control),
          cuaDriverOverridesUserConfig: true,
        });
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(withCua("control:a"));
        f.start(f.managed("control:a"));
        yield* f.turnStart(3, 1, true);
        f.turnCompleted(1);
        // Codex resumes a thread cold only from idle: a failed root would keep its old config.
        f.status("cua-root-failed", "systemError");
        yield* f.turnStart(4, 2, true, true);
        f.turnCompleted(2);
        yield* f.turnStart(f.reload(5, f.managed("control:b")), 3, true);
        f.turnCompleted(3);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* sessions.set(withCua("control:b"));
        for (const ordinal of [2, 3]) {
          yield* replay.startTurn(ordinal);
          yield* replay.terminal;
        }
        assert.deepEqual(
          replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
          [f.managed("control:a"), f.managed("control:b")],
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("reloads when Codex has goals turned off, instead of deferring forever (#1564)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("cua-goals-off");
        const withCua = (control: string) => ({
          ...f.config,
          cuaDriver: f.driver(control),
          cuaDriverOverridesUserConfig: true,
        });
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(withCua("control:a"));
        f.start(f.managed("control:a"));
        yield* f.turnStart(3, 1, true);
        f.turnCompleted(1);
        const off = { error: { code: -32600, message: "goals feature is disabled" } };
        yield* f.turnStart(f.reload(4, f.managed("control:b"), undefined, off), 2, true);
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* sessions.set(withCua("control:b"));
        yield* replay.startTurn(2);
        yield* replay.terminal;
        assert.deepEqual(
          replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
          [f.managed("control:a"), f.managed("control:b")],
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});
