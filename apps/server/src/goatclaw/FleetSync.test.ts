import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, GoatclawFleetPolicy, type GoatclawSettings } from "@goat/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import { mcpClientScopes } from "../auth/mcpClientScopes.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { client, dependencies } from "../mcp/agentSurface.testkit.ts";
import * as FleetHandlers from "../mcp/toolkits/fleet/handlers.ts";
import { FleetToolkit } from "../mcp/toolkits/fleet/tools.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { withLinkedHost } from "../sshRemote/testkit/LinkedHostFixture.ts";
import * as FleetSync from "./FleetSync.ts";

type Machine = Effect.Success<ReturnType<typeof machine>>;
const decodePolicy = Schema.decodeUnknownEffect(GoatclawFleetPolicy);

/** One GOAT's settings and fleet sync; `reach` answers its calls to connected hosts. */
const machine = (
  goatclaw: Partial<GoatclawSettings>,
  reach?: (
    call: SshRemoteDispatch.SshHostToolCall,
  ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>,
) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const sync = yield* FleetSync.make;
    return { settings, sync, goatclaw: settings.getSettings.pipe(Effect.map((s) => s.goatclaw)) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettingsService.layerTest({ goatclaw }),
        Layer.mock(LinkedHosts.LinkedHosts)({ find: () => Effect.succeedNone }),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)(
          reach === undefined
            ? { connectedHosts: Effect.succeed([]) }
            : { connectedHosts: Effect.succeed(["box"]), callHostTool: (call) => reach(call) },
        ),
      ),
    ),
  );

/** A connected host running a current GOAT: the call reaches its own fleet sync. */
const connectedTo = (remote: Machine) => (call: SshRemoteDispatch.SshHostToolCall) =>
  Effect.gen(function* () {
    expect(call.tool).toBe(FleetSync.SYNC_TOOL);
    expect(call.settingsWrite).toBe(true);
    const policy = yield* decodePolicy(call.arguments.policy).pipe(Effect.orDie);
    return { policy: yield* remote.sync.receive(policy).pipe(Effect.orDie) };
  });

/** Fleet sync over the real linked dispatch; the host echoes the policy it was sent. */
const syncOverLink = (access: LinkedHosts.LinkedHost["access"]) =>
  withLinkedHost(
    (request) =>
      request.method === "tools/call"
        ? { result: { structuredContent: request.args } }
        : { result: {} },
    Effect.gen(function* () {
      const sync = yield* FleetSync.make;
      return yield* sync.ensure("box");
    }).pipe(Effect.provide(ServerSettingsService.layerTest({ goatclaw: { enabled: true } }))),
    undefined,
    access,
  );

const credential = (token: string): Option.Option<LinkedHosts.LinkedHostCredential> =>
  Option.some({
    host: {
      name: "box",
      baseUrl: "https://box.example.ts.net",
      environmentId: "env-box",
      label: "Build box",
      serverVersion: "0.1.9",
      access: "full-access",
      linkedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
    token,
  });

const credentialAt = (access: LinkedHosts.LinkedHost["access"]) =>
  Option.map(credential("a"), (link) => ({ ...link, host: { ...link.host, access } }));

/**
 * Runs one sync whose dispatch evaluates the ceiling three times, as the SSH route does
 * (routing, session, tools/call), and swaps the link to `next` just before evaluation `at`.
 * Returns every ceiling handed out and the outcome fleet sync recorded.
 */
const ceilingsAcrossChange = (
  initial: Option.Option<LinkedHosts.LinkedHostCredential>,
  at: number,
  next: Option.Option<LinkedHosts.LinkedHostCredential>,
) =>
  Effect.gen(function* () {
    let current = initial;
    const granted: Array<string> = [];
    const { reach, recorded } = yield* Effect.gen(function* () {
      const sync = yield* FleetSync.make;
      const reach = yield* sync.ensure("box");
      return { reach, recorded: yield* sync.hostState("box") };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({ goatclaw: { enabled: true } }),
          Layer.mock(LinkedHosts.LinkedHosts)({ find: () => Effect.sync(() => current) }),
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
            connectedHosts: Effect.succeed(["box"]),
            callHostTool: (_call, authorize) =>
              Effect.gen(function* () {
                for (const evaluation of [0, 1, 2]) {
                  if (evaluation === at) current = next;
                  granted.push(yield* authorize);
                }
                return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unavailable",
                  message: "box did not answer.",
                });
              }),
          }),
        ),
      ),
    );
    expect(recorded).toEqual(reach.sync);
    return { granted, message: recorded.message, state: recorded.state };
  });

describe("GoatclawFleetSync", () => {
  it.effect("regression #3087: applies goatclaw policy to a host linked with full access", () =>
    Effect.gen(function* () {
      const { result, record } = yield* syncOverLink("full-access");
      expect(result).toMatchObject({
        _tag: "Success",
        success: { sync: { state: "applied" }, enforcesCeilings: true },
      });
      expect(record.filter((entry) => entry.method === "tools/call")).toHaveLength(1);
    }),
  );

  it.effect("sends no goatclaw policy through a read-only link", () =>
    Effect.gen(function* () {
      const { result, record } = yield* syncOverLink("read-only");
      expect(result).toMatchObject({
        _tag: "Success",
        success: { sync: { state: "pending", message: expect.stringContaining("read-only") } },
      });
      expect(record.filter((entry) => entry.method === "tools/call")).toEqual([]);
    }),
  );

  it.effect("leaves a downgraded link pending before the remote call", () =>
    Effect.gen(function* () {
      for (const at of [0, 1, 2]) {
        const outcome = yield* ceilingsAcrossChange(credential("a"), at, credentialAt("auto"));
        expect(outcome.granted).toEqual(Array.from({ length: at }, () => "full-access"));
        expect(outcome.state).toBe("pending");
        expect(outcome.message).toBe(
          "The link to box changed during the goatclaw sync; nothing was sent.",
        );
      }
    }),
  );

  it.effect("uses the approval-required ceiling for an SSH host", () =>
    Effect.gen(function* () {
      const outcome = yield* ceilingsAcrossChange(Option.none(), -1, Option.none());
      expect(outcome.granted).toEqual([
        "approval-required",
        "approval-required",
        "approval-required",
      ]);
    }),
  );

  it.effect("the remote handler applies full-access policy and refuses lesser link sessions", () =>
    Effect.gen(function* () {
      for (const access of [
        "full-access",
        "approval-required",
        "auto-accept-edits",
        "auto",
      ] as const) {
        const remote = yield* machine({});
        const program = Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const scope: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("remote"),
            requestNamespace: "client:link",
            thread: undefined,
            client: { sessionId: "link", label: "linked GOAT", access },
            capabilities: new Set(["orchestration"]),
            issuedAt: 0,
            grantedScopes: mcpClientScopes(access),
            reauthorize: () => Effect.void,
          };
          const calls: unknown[] = [];
          const ceilings: string[] = [];
          const incoming = Promise.withResolvers<{
            args: Record<string, unknown>;
            reply: (answer: { result: unknown } | { rpcError: string }) => void;
          }>();
          const remoteCall = yield* Effect.forkChild(
            Effect.gen(function* () {
              const request = yield* Effect.promise(() => incoming.promise);
              const result = yield* server
                .callTool({ name: "goat_permission_profile_sync", arguments: request.args })
                .pipe(
                  Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                  Effect.provideService(McpSchema.McpServerClient, client),
                  Effect.result,
                );
              request.reply(
                result._tag === "Success"
                  ? { result: result.success }
                  : { rpcError: String(result.failure) },
              );
            }),
          );
          const outcome = yield* withLinkedHost(
            async (request) => {
              if (request.method !== "tools/call") return { result: {} };
              calls.push(request.args);
              return await new Promise<{ result: unknown } | { rpcError: string }>((reply) =>
                incoming.resolve({ args: request.args as Record<string, unknown>, reply }),
              );
            },
            Effect.gen(function* () {
              const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
              const sync = yield* FleetSync.make.pipe(
                Effect.provideService(
                  SshRemoteDispatch.SshRemoteDispatch,
                  SshRemoteDispatch.SshRemoteDispatch.of({
                    ...dispatch,
                    callHostTool: (call, authorize) =>
                      dispatch.callHostTool(
                        call,
                        Effect.tap(authorize, (ceiling) =>
                          Effect.sync(() => void ceilings.push(ceiling)),
                        ),
                      ),
                  }),
                ),
              );
              const reach = yield* sync.ensure("box");
              return { reach, state: yield* sync.hostState("box") };
            }).pipe(
              Effect.provide(ServerSettingsService.layerTest({ goatclaw: { enabled: true } })),
            ),
            undefined,
            access,
          ).pipe(
            Effect.provide(
              Layer.mock(CloudMachineService.CloudMachineService)({
                onAliasInvalidated: () => Effect.void,
                owns: () => Effect.succeed(false),
              }),
            ),
          );
          expect(calls).toHaveLength(1);
          yield* Fiber.join(remoteCall);
          expect(calls[0]).toMatchObject({ policy: { enabled: true } });
          expect(ceilings.length).toBeGreaterThan(0);
          expect(ceilings.every((ceiling) => ceiling === access)).toBe(true);
          expect(outcome.result).toMatchObject(
            access === "full-access"
              ? {
                  _tag: "Success",
                  success: { reach: { sync: { state: "applied" } }, state: { state: "applied" } },
                }
              : {
                  _tag: "Success",
                  success: {
                    reach: {
                      sync: {
                        state: "pending",
                        message: expect.stringContaining(
                          "Only a connected GOAT allowed to change this machine's settings syncs goatclaw policy.",
                        ),
                      },
                    },
                    state: { state: "pending" },
                  },
                },
          );
          expect((yield* remote.goatclaw).enabled).toBe(access === "full-access");
        });
        yield* program.pipe(
          Effect.provide(
            McpHttpServer.toolkitRegistration(FleetToolkit, FleetHandlers.layer).pipe(
              Layer.provideMerge(Layer.succeed(FleetSync.GoatclawFleetSync, remote.sync)),
              Layer.provideMerge(McpServer.McpServer.layer),
              Layer.provideMerge(dependencies),
            ),
          ),
        );
      }
    }),
  );

  it.effect(
    "invariant: a ceiling raised for a link is refused once that link changes, on any evaluation",
    () =>
      Effect.gen(function* () {
        const changed = "The link to box changed during the goatclaw sync; nothing was sent.";
        // Removed or replaced before the first evaluation, before the linked route's recheck,
        // or before the SSH route's last recheck.
        expect(yield* ceilingsAcrossChange(credential("a"), 0, Option.none())).toEqual({
          granted: [],
          message: changed,
          state: "pending",
        });
        expect(yield* ceilingsAcrossChange(credential("a"), 0, credential("b"))).toEqual({
          granted: [],
          message: changed,
          state: "pending",
        });
        expect(yield* ceilingsAcrossChange(credential("a"), 1, Option.none())).toEqual({
          granted: ["full-access"],
          message: changed,
          state: "pending",
        });
        expect(yield* ceilingsAcrossChange(credential("a"), 2, credential("b"))).toEqual({
          granted: ["full-access", "full-access"],
          message: changed,
          state: "pending",
        });
        // A link that appears after the sync looked never raises it.
        expect(yield* ceilingsAcrossChange(Option.none(), 0, credential("a"))).toEqual({
          granted: ["approval-required", "approval-required", "approval-required"],
          message: "box did not answer.",
          state: "pending",
        });
      }),
  );

  it.effect("applies goatclaw switched on here to a connected host", () =>
    Effect.gen(function* () {
      const remote = yield* machine({});
      const local = yield* machine({}, connectedTo(remote));
      yield* TestClock.adjust("1 minute");
      yield* local.settings.updateSettings({
        goatclaw: { enabled: true, defaultProfile: "owner" },
      });

      const reach = yield* local.sync.ensure("box");

      expect(reach).toEqual({ sync: { state: "applied" }, enforcesCeilings: true });
      const applied = yield* remote.goatclaw;
      expect(applied.enabled).toBe(true);
      expect(applied.defaultProfile).toBe("owner");
      expect(applied.updatedAt).toBe((yield* local.goatclaw).updatedAt);
      expect(yield* local.sync.hostState("box")).toEqual({ state: "applied" });
    }),
  );

  it.effect("pushes a later change here on the next reconcile and adopts one made there", () =>
    Effect.gen(function* () {
      const remote = yield* machine({});
      const local = yield* machine({}, connectedTo(remote));
      yield* local.settings.updateSettings({ goatclaw: { enabled: true } });
      yield* local.sync.reconcile;
      expect((yield* remote.goatclaw).enabled).toBe(true);

      yield* TestClock.adjust("1 minute");
      yield* local.settings.updateSettings({ goatclaw: { defaultProfile: "manager" } });
      yield* local.sync.reconcile;
      expect((yield* remote.goatclaw).defaultProfile).toBe("manager");

      // Switching it off on the host is the newest change, so it turns off here as well.
      yield* TestClock.adjust("1 minute");
      yield* remote.settings.updateSettings({ goatclaw: { enabled: false } });
      yield* local.sync.reconcile;
      expect((yield* local.goatclaw).enabled).toBe(true);
      yield* TestClock.adjust(FleetSync.REFRESH_MS);
      yield* local.sync.reconcile;
      expect((yield* local.goatclaw).enabled).toBe(false);
    }),
  );

  it.effect("never lets a policy nobody set override one somebody did", () =>
    Effect.gen(function* () {
      // Switched on by hand before fleet sync existed: no stamp, but still a person's choice.
      const remote = yield* machine({});
      const local = yield* machine({ enabled: true }, connectedTo(remote));
      expect((yield* local.goatclaw).updatedAt).toBeUndefined();

      expect((yield* local.sync.ensure("box")).sync.state).toBe("applied");
      expect((yield* remote.goatclaw).enabled).toBe(true);
      expect((yield* local.goatclaw).updatedAt).toBeDefined();

      const untouched = yield* machine({});
      const kept = yield* local.sync.receive(yield* untouched.goatclaw);
      expect(kept.enabled).toBe(true);
    }),
  );

  it.effect("tells an outdated host from one that cannot take the policy yet", () =>
    Effect.gen(function* () {
      const cases = [
        {
          error: new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message: `GOAT on box does not have ${FleetSync.SYNC_TOOL}; it runs 0.1.1 and this machine runs 0.1.2.`,
          }),
          state: "outdated",
          enforcesCeilings: false,
        },
        {
          // A linked host whose token lacks settings:write: its GOAT answered, so it is current.
          error: new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message:
              "Only a connected GOAT allowed to change this machine's settings syncs goatclaw policy.",
            remoteCode: "capability_denied",
          }),
          state: "pending",
          enforcesCeilings: true,
        },
        {
          error: new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "box did not answer.",
          }),
          state: "pending",
          enforcesCeilings: false,
        },
      ] as const;
      for (const { error, state, enforcesCeilings } of cases) {
        const local = yield* machine({ enabled: true }, () => Effect.fail(error));
        const reach = yield* local.sync.ensure("box");
        expect(reach.sync.state).toBe(state);
        expect(reach.enforcesCeilings).toBe(enforcesCeilings);
      }
    }),
  );
  it.effect("connects like the launch or send it precedes, while the reconcile wakes nothing", () =>
    Effect.gen(function* () {
      const remote = yield* machine({});
      const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
      const local = yield* machine({ enabled: true }, (call) => {
        calls.push(call);
        return connectedTo(remote)(call);
      });
      yield* local.sync.reconcile;
      yield* local.settings.updateSettings({ goatclaw: { defaultProfile: "manager" } });
      yield* local.sync.ensure("box");
      // A launcher on another build sees a compatible runtime as not ready; the send's own
      // connection must decide, or every profiled send is refused until the host updates.
      expect(calls.map((call) => call.requireReady)).toEqual([true, undefined]);
    }),
  );
  it.effect(
    "admits a launch and the follow-up send to a host alike while its sync is unconfirmed",
    () =>
      Effect.gen(function* () {
        const failures = [
          {
            reason: "remote_refused",
            message: `GOAT on box does not have ${FleetSync.SYNC_TOOL}.`,
          },
          { reason: "host_unavailable", message: "box did not answer." },
        ] as const;
        for (const failure of failures) {
          let attempts = 0;
          const local = yield* machine({ enabled: true }, () => {
            attempts += 1;
            return Effect.fail(new SshRemoteDispatch.SshRemoteDispatchError(failure));
          });
          const launch = yield* FleetSync.syncBeforeForwarding(local.sync, "box");
          const send = yield* FleetSync.syncBeforeForwarding(local.sync, "box");
          expect(launch).toMatchObject({ enforcement: "unconfirmed", host: "box" });
          expect(send).toEqual(launch);
          // Neither call is refused, and each retries the sync so the ceiling lands once it can.
          expect(attempts).toBe(2);
        }
      }),
  );
});
