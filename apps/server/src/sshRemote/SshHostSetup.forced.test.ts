import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type Handoff,
  type SshHostResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as SshHostSetup from "./SshHostSetup.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import { dependencies } from "./testkit/SshHostSetupTestkit.ts";
import { stopped, fixtureWith } from "./testkit/SshRuntimeUpdateFixture.ts";
const replaceTarget = { pid: 43406, port: 3773, startedAt: "Tue Nov 11 08:01:02 2026" };

it.effect("a forced update approval names the runtime process it may stop", () =>
  Effect.gen(function* () {
    const f = yield* fixtureWith({
      ...stopped,
      state: "update_blocked",
      runtimeVersion: "0.1.6",
      replaceTarget,
    });
    const result = yield* f.setup.update(
      { host: "box", mode: "now" },
      {
        kind: "mcp",
        scope: {
          ...f.scope,
          client: undefined,
          thread: {
            threadId: ThreadId.make("caller"),
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          grantedScopes: ["orchestration:read"],
          reauthorize: () => Effect.void,
        },
      },
    );
    expect(result.kind).toBe("needs_human");
    const [approval] = f.approvals;
    expect(approval?.title).toContain("PID 43406");
    expect(approval?.reason).toContain("PID 43406");
    expect(approval?.reason).toContain("Tue Nov 11 08:01:02 2026 UTC");
    expect(approval?.reason).toContain("port 3773");
    // The person reads first what happens if the new version does not start.
    expect(approval?.reason).toContain("starts the stopped version again when it can");
    expect(approval?.reason).toContain("no runtime runs on box until you update again");
    // Children are never signalled; one still running is named for the person.
    expect(approval?.reason).toContain(
      "Its child processes are not signalled: any still running are named in that host's GOAT log for you to check.",
    );
    expect(approval?.args).toMatchObject({ step: "runtime_update", replace: replaceTarget });
    expect(f.updates).toEqual([]);
  }),
);

const approvedForcedUpdate = (live: typeof replaceTarget | undefined) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const completed = yield* Deferred.make<void>();
    const forced: Array<unknown> = [];
    const operation = { operationId: "forced-op", generation: 1, stage: "runtime" as const };
    let snapshot: SshHostResult = {
      kind: "ok",
      status: {
        ...stopped,
        state: "update_blocked",
        runtimeVersion: "0.1.6",
        setup: operation,
        ...(live === undefined ? {} : { replaceTarget: live }),
      },
    };
    const handoff: Handoff = {
      handoffId: TurnItemId.make("forced-update"),
      kind: "approval",
      title: "Update box?",
      reason: "Replace runtime",
      requestedBy: {
        threadId: ThreadId.make("caller"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        path: "ssh.runtime_update",
      },
      target: { environmentId: EnvironmentId.make("owner"), path: "ssh.runtime_update" },
      dedupeKey: "test",
      state: "completed",
      createdAt: DateTime.subtract(now, { minutes: 2 }),
      expiresAt: DateTime.add(now, { hours: 23 }),
      resolvedAt: DateTime.subtract(now, { minutes: 1 }),
      actor: { type: "client", label: "Reviewer" },
    };
    const sessionId = AuthSessionId.make("reviewer");
    const layer = SshHostSetup.layer.pipe(
      Layer.provide(
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "test",
          legacyCookieName: undefined,
          listActive: () =>
            Effect.succeed([
              {
                sessionId,
                subject: "reviewer",
                method: "browser-session-cookie",
                scopes: ["environment:maintain", "orchestration:read"],
                client: { label: "Reviewer", deviceType: "unknown" },
                issuedAt: now,
                expiresAt: DateTime.add(now, { hours: 1 }),
                lastConnectedAt: now,
                connected: true,
                current: true,
              },
            ]),
        }),
      ),
      Layer.provide(
        Layer.mock(Handoffs.Handoffs)({
          resolvedSshOutcomes: Effect.succeed([]),
          completedSshContinuations: Effect.succeed([
            {
              handoff,
              approvedBySessionId: sessionId,
              sshProgress: {
                host: "box",
                operationId: operation.operationId,
                aliasGeneration: operation.generation,
                environmentId: EnvironmentId.make("owner"),
                threadId: ThreadId.make("caller"),
              },
              args: {
                version: 1,
                step: "runtime_update",
                host: "box",
                operationId: operation.operationId,
                aliasGeneration: operation.generation,
                requestedVersion: stopped.requestedVersion,
                replace: replaceTarget,
              },
            },
          ]),
          bindSshContinuation: () => Effect.void,
          finishSshContinuation: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
        }),
      ),
      Layer.provide(
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          publishSetupOutcome: (_host, _operation, outcome) =>
            Effect.sync(() => {
              if (outcome.kind === "error")
                snapshot = {
                  kind: "ok",
                  status: {
                    ...stopped,
                    state: "failed",
                    setup: { ...operation, stage: "complete" },
                    failure: { reason: outcome.reason, fix: outcome.fix },
                    detail: outcome.message,
                  },
                };
              return true;
            }),
          runtimeStatus: () => Effect.sync(() => snapshot),
          runtimeUpdate: (_host, options) =>
            Effect.sync(() => {
              forced.push(options.forceReplace);
              snapshot = {
                kind: "ok",
                status: { ...stopped, state: "ready", setup: { ...operation, stage: "complete" } },
              };
              return snapshot;
            }),
        }),
      ),
      Layer.provide(dependencies),
    );
    const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
    yield* setup.resumeContinuations;
    yield* Deferred.await(completed);
    return { forced, status: yield* setup.status({ host: "box" }) };
  });

it.effect("an approved forced update passes the approved runtime process to the host", () =>
  Effect.gen(function* () {
    const { forced } = yield* approvedForcedUpdate(replaceTarget);
    expect(forced).toEqual([replaceTarget]);
  }),
);

it.effect.each([
  {
    name: "a restarted process",
    live: { ...replaceTarget, startedAt: "Tue Nov 11 09:00:00 2026" },
  },
  { name: "another PID", live: { ...replaceTarget, pid: 50000 } },
  { name: "no process", live: undefined },
])("an approved forced update for $name runs nothing and asks again", ({ live }) =>
  Effect.gen(function* () {
    const { forced, status } = yield* approvedForcedUpdate(live);
    expect(forced).toEqual([]);
    expect(status).toMatchObject({
      status: { state: "failed", failure: { reason: "approval_expired" } },
    });
    expect(status.status?.detail).toContain("PID 43406");
  }),
);
