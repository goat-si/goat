import type { ComputerUseHolder } from "./computerUseGrants.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  type CuaDriverMcpConfiguration,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import * as ComputerUse from "./ComputerUseAttachment.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as ComputerUseOrigin from "./ComputerUseOrigin.ts";
import * as ComputerUsePrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import * as CuaDriver from "./CuaDriver.ts";
import * as ServerSettings from "../serverSettings.ts";

const mcp: CuaDriverMcpConfiguration = {
  command: "/driver/cua-driver",
  args: ["mcp", "--socket", "/tmp/cua.sock"],
  environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
  socketPath: "/tmp/cua.sock",
};

const lease: ComputerUseLeases.ComputerUseLease = {
  threadId: ThreadId.make("thread-cua"),
  handoffId: TurnItemId.make("handoff:grant"),
  expiresAt: DateTime.makeUnsafe("2026-10-21T12:30:00.000Z"),
};
const proxy = { command: "/goat/node", entrypoint: "/goat/bin.mjs" };
const ROUTE = "/api/computer-use/lease";

/** Leases that hold `grant` for the thread and mint one control per grant they are asked for. */
const fakeLeases = (input: {
  readonly grant?: ComputerUseLeases.ComputerUseLease;
  readonly proxy?: typeof proxy | undefined;
  readonly detection?: ComputerUseLeases.ComputerUseDetection;
  /** Another thread holding the screen for unattended work. */
  readonly holder?: ComputerUseHolder;
  /** The screen was claimed between the holder check and the claim. */
  readonly claimLost?: boolean;
}) => {
  const minted: Array<Option.Option<ComputerUseLeases.ComputerUseLease>> = [];
  const blocked: Array<{ readonly threadId: string; readonly block: unknown }> = [];
  /** Every control on every app asked for, by whether it was for unattended work. */
  const everyApp: Array<boolean> = [];
  const service = ComputerUseLeases.ComputerUseLeases.of({
    active: () => Effect.succeed(Option.fromNullishOr(input.grant)),
    holder: () => Effect.succeed(Option.fromNullishOr(input.holder)),
    channelOrigin: () => Effect.die("unused"),
    state: () => Effect.die("unused"),
    attached: () => Effect.succeedNone,
    nameApps: () => Effect.void,
    everyAppControl: (threadId, unattended) =>
      Effect.sync(() => {
        everyApp.push(unattended);
        return input.claimLost === true
          ? Option.none()
          : Option.some({
              controlId: "control:every-app",
              threadId,
              expiresAt: DateTime.makeUnsafe("2026-10-21T13:00:00.000Z"),
            });
      }),
    serializeAdmission: (effect) => effect,
    control: (threadId, grant) =>
      Effect.sync(() => {
        minted.push(grant);
        return {
          controlId: Option.isSome(grant) ? "control:unattended" : "control:interactive",
          threadId,
          expiresAt: Option.isSome(grant)
            ? grant.value.expiresAt
            : DateTime.makeUnsafe("2026-10-21T13:00:00.000Z"),
          ...(Option.isSome(grant) ? { handoffId: grant.value.handoffId } : {}),
        };
      }),
    currentControl: () => Effect.die("unused"),
    controlState: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    setTarget: () => Effect.die("unused"),
    callReservation: () => Effect.die("unused"),
    releaseApps: () => Effect.void,
    streamOpened: () => Effect.void,
    foregroundApprovalEpoch: Effect.die("unused"),
    approveForeground: () => Effect.die("unused"),
    foregroundAvailable: () => Effect.die("unused"),
    humanInput: () => Effect.die("unused"),
    agentInput: () => Effect.die("unused"),
    stopAll: Effect.die("unused"),
    // Every attachment here is for a turn whose run is open.
    turnEnded: () => Effect.succeed(false),
    settle: Effect.die("unused"),
    disable: Effect.die("unused"),
    grants: Effect.die("unused"),
    release: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    detection: Effect.succeed(
      input.detection ?? { humanInput: true, privateMode: true, frames: false },
    ),
    resume: Effect.die("unused"),
    hold: () => Effect.die("unused"),
    sessions: Effect.die("unused"),
    subscribe: Effect.die("unused"),
    changed: Effect.die("unused"),
    proxy: "proxy" in input ? input.proxy : proxy,
    blocked: (threadId, block) => Effect.sync(() => void blocked.push({ threadId, block })),
    blockedTurns: Effect.die("unused"),
  });
  return { leases: Option.some(service), minted, blocked, everyApp };
};
const interactiveControl = {
  controlId: "control:interactive",
  threadId: ThreadId.make("thread-cua"),
  expiresAt: DateTime.makeUnsafe("2026-10-21T13:00:00.000Z"),
};

const fakeDriver = (input: {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly x11Display?: CuaDriver.CuaX11Display;
  readonly failure?: CuaDriver.CuaDriverError;
}) => {
  const calls = { acquire: 0 };
  const service = CuaDriver.CuaDriver.of({
    ...(input.x11Display === undefined
      ? {}
      : { x11Display: Effect.succeed(Option.some(input.x11Display)) }),
    enabled: Effect.succeed(input.enabled),
    acquire: Effect.sync(() => {
      calls.acquire++;
      return input.running ? Option.some(mcp) : Option.none();
    }),
    listedApps: Effect.succeedNone,
    appCatalog: Effect.succeed([]),
    lastFailure: Effect.succeed(Option.fromUndefinedOr(input.failure)),
    block: Effect.succeed(undefined),
    status: Effect.succeed({ platform: "darwin", running: input.running }),
    computerUse: Effect.die("unused"),
    admitEnable: Effect.die("unused"),
  });
  return { service: Option.some(service), calls };
};

const interactive = { _tag: "interactive" } as const;
const unattended = { _tag: "unattended", reason: "goat_bot" } as const;

const input = (
  overrides: Partial<ComputerUse.ComputerUseAttachmentInput> = {},
): ComputerUse.ComputerUseAttachmentInput => ({
  threadId: ThreadId.make("thread-cua"),
  driver: ProviderDriverKind.make("codex"),
  interactionMode: "default",
  readOnly: false,
  origin: interactive,
  leases: fakeLeases({}).leases,
  ...overrides,
});

const allowFullAccess = (allow: boolean) =>
  ServerSettings.ServerSettingsService.layerTest({ cuaFullAccessAutoAdmit: allow });

const decide = (
  driver: ReturnType<typeof fakeDriver>,
  overrides: Partial<ComputerUse.ComputerUseAttachmentInput> = {},
) => ComputerUse.computerUseAttachment(driver.service, input(overrides));

const session: McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("environment-cua"),
  threadId: ThreadId.make("thread-cua"),
  providerSessionId: "credential",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:4100/mcp",
  authorizationHeader: "Bearer fixture",
  browserToolsAvailable: false,
};

describe("computerUseAttachment", () => {
  it.effect("detached attachment cleanup revokes only its own channel token", () =>
    Effect.gen(function* () {
      const signals = yield* PubSub.unbounded<void>();
      const leases = ComputerUseLeases.ComputerUseLeases.of({
        subscribe: PubSub.subscribe(signals),
        currentControl: () => Effect.succeed(Option.some({ controlId: "control:one" })),
        controlState: () => Effect.succeed({ _tag: "active" }),
      } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]);
      const channel = yield* ComputerUsePrimitiveChannel.make.pipe(
        Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
      );
      const token = "channel:old";
      const config = {
        ...session,
        cuaDriver: {
          command: "/goat/node",
          args: [],
          environment: [{ name: ComputerUse.LEASE_PROXY_ENV.proxyChannelToken, value: token }],
        },
      };
      const sessions = McpProviderSessions.McpProviderSessions.of({
        read: () => Effect.succeed(config),
      } as unknown as McpProviderSessions.McpProviderSessions["Service"]);
      const issue = (proxyChannelToken: string, attachmentGeneration: string) =>
        channel.issue({
          threadId: session.threadId,
          controlId: "control:one",
          proxyChannelToken,
          attachmentGeneration,
          expiresAt: 60_000,
        });
      yield* issue(token, "attachment:old");
      yield* ComputerUse.revokeProxyChannelAttachment(
        Option.some(channel),
        sessions,
        session.threadId,
        "unrelated-credential",
      );
      assert.equal(
        yield* channel.authenticate({ threadId: session.threadId, proxyChannelToken: token }),
        "attachment:old",
      );
      yield* ComputerUse.revokeProxyChannelAttachment(
        Option.some(channel),
        sessions,
        session.threadId,
        session.providerSessionId,
      );
      assert.isUndefined(
        yield* channel.authenticate({ threadId: session.threadId, proxyChannelToken: token }),
      );
      yield* issue("channel:new", "attachment:new");
      yield* ComputerUse.revokeProxyChannelAttachment(
        Option.some(channel),
        sessions,
        session.threadId,
        session.providerSessionId,
      );
      assert.equal(
        yield* channel.authenticate({
          threadId: session.threadId,
          proxyChannelToken: "channel:new",
        }),
        "attachment:new",
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each(["codex", "fx"])(
    "routes an interactive %s thread through the proxy under a control",
    (provider) =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        const leases = fakeLeases({});
        const attached = yield* decide(driver, {
          driver: ProviderDriverKind.make(provider),
          leases: leases.leases,
        });
        if (attached._tag !== "proxied") throw new Error("expected proxy attachment");
        // Without a primitive channel on this server the proxy gets no reverse-channel secret.
        assert.equal(attached.proxyChannelToken, undefined);
        assert.deepEqual(attached, {
          _tag: "proxied",
          mcp,
          attachmentGeneration: attached.attachmentGeneration,
          control: interactiveControl,
          proxy,
          // A cua-driver the person configured would skip Stop, pauses and app approvals.
          overrideUserConfig: true,
          skills: ["computer-use", "screen-code"],
        });
        assert.equal(driver.calls.acquire, 1);
        // An interactive control is not tied to a grant, even when the thread holds one.
        assert.deepEqual(leases.minted, [Option.none()]);
      }),
  );

  it.effect("drops only the computer-use guide for the project that switched it off", () =>
    Effect.gen(function* () {
      const optedOut = ProjectId.make("project-cua-off");
      const skills = (projectId: ProjectId) =>
        decide(fakeDriver({ enabled: true, running: true }), {
          leases: fakeLeases({}).leases,
          projectId,
        }).pipe(
          Effect.map((attached) => (attached._tag === "proxied" ? attached.skills : null)),
          Effect.provide(
            ServerSettings.ServerSettingsService.layerTest({
              projectSettingsOverrides: {
                [optedOut]: { builtInSkills: { "computer-use": { enabled: false } } },
              },
            }),
          ),
        );
      assert.deepEqual(yield* skills(optedOut), ["screen-code"]);
      assert.deepEqual(yield* skills(ProjectId.make("project-cua-on")), [
        "computer-use",
        "screen-code",
      ]);
    }),
  );

  it.effect("a project with computer-use guide off keeps the proxy and screen-code guide", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-cua-off");
      const attached = yield* decide(fakeDriver({ enabled: true, running: true }), {
        leases: fakeLeases({}).leases,
        projectId,
      }).pipe(
        Effect.provide(
          ServerSettings.ServerSettingsService.layerTest({
            projectSettingsOverrides: {
              [projectId]: { builtInSkills: { "computer-use": { enabled: false } } },
            },
          }),
        ),
      );
      if (attached._tag !== "proxied") throw new Error("expected proxy attachment");
      assert.deepEqual(attached.skills, ["screen-code"]);
      const config = ComputerUse.withComputerUse(session, attached, ROUTE);
      assert.deepInclude(config.cuaDriver?.environment ?? [], {
        name: ComputerUse.LEASE_PROXY_ENV.driver,
        value: JSON.stringify(mcp),
      });
    }),
  );

  it.effect.each(["codex", "fx"])(
    "keeps %s tools but drops the skill the person switched off in Settings",
    (provider) =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        const attached = yield* decide(driver, {
          driver: ProviderDriverKind.make(provider),
          leases: fakeLeases({}).leases,
        }).pipe(
          Effect.provide(
            ServerSettings.ServerSettingsService.layerTest({
              disabledBuiltInSkills: ["computer-use", "skill-from-a-newer-build"],
            }),
          ),
        );
        assert.deepEqual(attached._tag === "proxied" ? attached.skills : null, ["screen-code"]);
        const config = ComputerUse.withComputerUse(session, attached, ROUTE);
        assert.isDefined(config.cuaDriver);
        assert.isFalse(McpProviderSession.carriesComputerUseSkill(config));
        const defaults = yield* decide(driver, {
          driver: ProviderDriverKind.make(provider),
          leases: fakeLeases({}).leases,
        });
        assert.isTrue(
          McpProviderSession.carriesComputerUseSkill(
            ComputerUse.withComputerUse(session, defaults, ROUTE),
          ),
        );
      }),
  );

  // Every origin a run can have: interactive, and each unattended reason (automation, schedule,
  // webhook, Slack, channels, remote launches).
  const everyOrigin: ReadonlyArray<{
    readonly label: string;
    readonly origin: ComputerUse.ComputerUseAttachmentInput["origin"];
  }> = [
    { label: "a person", origin: interactive },
    ...(
      [
        "goat_bot",
        "channel_task",
        "channel_message",
        "scheduled_task",
        "sent_by_unattended",
        "launched_by_unattended",
        "launched_remotely",
        "unknown",
      ] as const
    ).map((reason) => ({
      label: `unattended ${reason}`,
      origin: { _tag: "unattended", reason } as const,
    })),
  ];

  it.effect.each(everyOrigin)(
    "D16: a full access run started by $label uses every app without approval, with the host setting off",
    ({ origin }) =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        const leases = fakeLeases({});
        const attached = yield* decide(driver, {
          origin,
          runtimeMode: "full-access",
          runId: RunId.make("run:origin"),
          leases: leases.leases,
        }).pipe(Effect.provide(allowFullAccess(false)));
        assert.equal(
          attached._tag === "proxied" ? attached.control.controlId : attached._tag,
          "control:every-app",
        );
        // A remote launch works beside other threads instead of holding the screen alone.
        assert.deepEqual(leases.everyApp, [
          origin._tag === "unattended" && origin.reason !== "launched_remotely",
        ]);
        assert.deepEqual(leases.minted, []);
      }),
  );

  it.effect.each(everyOrigin)(
    "a run outside full access started by $label still needs approval, with the host setting on",
    ({ origin }) =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        const leases = fakeLeases({});
        const attached = yield* decide(driver, {
          origin,
          runtimeMode: "approval-required",
          runId: RunId.make("run:origin"),
          leases: leases.leases,
        }).pipe(Effect.provide(allowFullAccess(true)));
        assert.deepEqual(leases.everyApp, []);
        if (origin._tag === "unattended") {
          assert.deepEqual(attached, {
            _tag: "none",
            reason: "needs-approval",
            blockUserConfig: true,
          });
          assert.deepEqual(leases.minted, []);
        } else {
          // An interactive control reaches only the apps a person approved for the thread.
          assert.equal(
            attached._tag === "proxied" ? attached.control.controlId : attached._tag,
            "control:interactive",
          );
          assert.deepEqual(leases.minted, [Option.none()]);
        }
      }),
  );

  it.effect.each([
    { humanInput: false, privateMode: false, frames: false },
    { humanInput: true, privateMode: false, frames: false },
  ])(
    "admits approved and full access unattended work on a host that does not detect secret fields (%o)",
    (detection) =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        const leased = fakeLeases({ grant: lease, detection });
        const approved = yield* decide(driver, { origin: unattended, leases: leased.leases });
        assert.equal(
          approved._tag === "proxied" ? approved.control.controlId : approved._tag,
          "control:unattended",
        );
        const full = fakeLeases({ detection });
        const everyApp = yield* decide(driver, {
          origin: unattended,
          runtimeMode: "full-access",
          leases: full.leases,
        });
        assert.equal(
          everyApp._tag === "proxied" ? everyApp.control.controlId : everyApp._tag,
          "control:every-app",
        );
        assert.deepEqual(full.everyApp, [true]);
      }),
  );

  it.effect.each([
    {
      label: "Plan",
      overrides: { interactionMode: "plan" },
      enabled: true,
      proxy: true,
      reason: "plan",
    },
    {
      label: "a read-only sandbox",
      overrides: { readOnly: true },
      enabled: true,
      proxy: true,
      reason: "read-only",
    },
    { label: "computer use off", overrides: {}, enabled: false, proxy: true, reason: "disabled" },
    { label: "no proxy", overrides: {}, enabled: true, proxy: false, reason: "unavailable" },
  ] as const)(
    "a full access remote launch refused for $label still keeps a cua-driver the user configured from running",
    ({ overrides, enabled, proxy: withProxy, reason }) =>
      Effect.gen(function* () {
        const attached = yield* decide(fakeDriver({ enabled, running: true }), {
          origin: { _tag: "unattended", reason: "launched_remotely" },
          runtimeMode: "full-access",
          runId: RunId.make("run:remote"),
          leases: fakeLeases(withProxy ? {} : { proxy: undefined }).leases,
          ...overrides,
        });
        assert.deepEqual(attached, { _tag: "none", reason, blockUserConfig: true });
        // A driver outside GOAT's proxy would not hear Stop, stop all or a takeover.
        assert.isTrue(ComputerUse.withComputerUse(session, attached, ROUTE).cuaDriverBlocked);
      }),
  );

  it.effect(
    "a full access thread launched from another environment uses every app on a host that does not detect secret fields",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-cua");
        const runId = RunId.make("run:remote");
        const at = DateTime.makeUnsafe("2026-10-21T12:00:00.000Z");
        const reads = {
          channelOrigin: () => Effect.succeed(undefined),
          thread: () =>
            Effect.succeed({
              createdAt: at,
              lineage: { parentThreadId: null, relationshipToParent: null },
              launchedBy: {
                kind: "launch" as const,
                threadId: ThreadId.make("thread-on-another-host"),
                environmentId: "environment-elsewhere",
              },
            }),
          runs: () =>
            Effect.succeed([
              {
                id: runId,
                userMessageId: MessageId.make("message:launch"),
                requestedAt: at,
                completedAt: null,
              },
            ]),
          message: () => Effect.succeed({ createdAt: at }),
        };
        const driver = fakeDriver({ enabled: true, running: true });
        const leases = fakeLeases({
          detection: { humanInput: false, privateMode: false, frames: false },
        });
        const attached = yield* decide(driver, {
          origin: yield* ComputerUseOrigin.computerUseOrigin(reads, { threadId, runId }),
          runtimeMode: "full-access",
          runId,
          leases: leases.leases,
        });
        assert.equal(
          attached._tag === "proxied" ? attached.control.controlId : attached._tag,
          "control:every-app",
        );
        // It works beside other threads instead of holding the screen alone.
        assert.deepEqual(leases.everyApp, [false]);
        assert.deepEqual(leases.minted, []);
      }),
  );

  it.effect("refuses full access unattended work while another thread holds the screen", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      const held = { _tag: "none", reason: "held", blockUserConfig: true } as const;
      const turn = (
        leases: ReturnType<typeof fakeLeases>,
        origin: ComputerUse.ComputerUseAttachmentInput["origin"] = unattended,
      ) =>
        decide(driver, { origin, runtimeMode: "full-access", leases: leases.leases }).pipe(
          Effect.provide(allowFullAccess(true)),
        );
      const holder = { threadId: ThreadId.make("thread-bot"), expiresAt: lease.expiresAt };
      const busy = fakeLeases({ holder });
      assert.deepEqual(yield* turn(busy), held);
      // Checked before the driver starts, so a held screen never starts it.
      assert.equal(driver.calls.acquire, 0);
      assert.deepEqual(busy.everyApp, []);
      // A thread that lost the claim to another between the check and the claim holds nothing.
      assert.deepEqual(yield* turn(fakeLeases({ claimLost: true })), held);
      // A person directing a thread can still use the screen beside unattended work.
      assert.equal((yield* turn(fakeLeases({ holder }), interactive))._tag, "proxied");
    }),
  );

  it.effect.each([
    { label: "interactive", origin: undefined, grant: undefined },
    { label: "leased unattended", origin: unattended, grant: lease },
  ])(
    "loads the skill switched off in Settings on a $label turn that asked for @computer",
    ({ origin, grant }) =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        const skillsFor = (requested: ReadonlyArray<"computer-use" | "browser">) =>
          decide(driver, {
            leases: fakeLeases(grant === undefined ? {} : { grant }).leases,
            requested,
            ...(origin === undefined ? {} : { origin }),
          }).pipe(
            Effect.map((attached) => (attached._tag === "proxied" ? attached.skills : null)),
            Effect.provide(
              ServerSettings.ServerSettingsService.layerTest({
                disabledBuiltInSkills: ["computer-use"],
              }),
            ),
          );
        assert.deepEqual(yield* skillsFor(["computer-use"]), ["computer-use", "screen-code"]);
        assert.deepEqual(yield* skillsFor(["browser"]), ["screen-code"]);
      }),
  );

  it.effect("gives an interactive turn no driver when nothing could stop it", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      for (const leases of [fakeLeases({ proxy: undefined }).leases, Option.none()])
        assert.deepEqual(yield* decide(driver, { leases }), {
          _tag: "none",
          reason: "unavailable",
          blockUserConfig: false,
        });
      assert.equal(driver.calls.acquire, 0);
    }),
  );

  it.effect.each(["codex", "fx"])(
    "refuses plan, read-only, disabled and cloud threads without starting the driver (%s)",
    (provider) =>
      Effect.gen(function* () {
        const cases = [
          [{ enabled: true }, { interactionMode: "plan" as const }, "plan"],
          [{ enabled: true }, { readOnly: true }, "read-only"],
          [{ enabled: false }, {}, "disabled"],
          [
            { enabled: true },
            { driver: ProviderDriverKind.make("claudeCloud") },
            "unsupported-provider",
          ],
          [
            { enabled: true },
            { driver: ProviderDriverKind.make("devinCloud") },
            "unsupported-provider",
          ],
          [{ enabled: true }, { driver: ProviderDriverKind.make("muse") }, "unsupported-provider"],
          [{ enabled: true }, { driver: undefined }, "unsupported-provider"],
        ] as const;
        for (const [settings, overrides, reason] of cases) {
          const driver = fakeDriver({ ...settings, running: true });
          assert.deepEqual(
            yield* decide(driver, { driver: ProviderDriverKind.make(provider), ...overrides }),
            {
              _tag: "none",
              reason,
              blockUserConfig: false,
            },
          );
          assert.equal(driver.calls.acquire, 0, reason);
        }
        assert.deepEqual(yield* ComputerUse.computerUseAttachment(Option.none(), input()), {
          _tag: "none",
          reason: "disabled",
          blockUserConfig: false,
        });
      }),
  );

  it.effect("reports an enabled driver that did not start as unavailable", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* decide(fakeDriver({ enabled: true, running: false })), {
        _tag: "none",
        reason: "unavailable",
        blockUserConfig: false,
      });
    }),
  );

  it.effect(
    "says which grant is missing when the desktop would not start the driver for it (#1399)",
    () =>
      Effect.gen(function* () {
        const block = {
          reason: "permissionsNotGranted",
          missing: ["screenRecording"],
          holder: "helper",
        } as const;
        const driver = fakeDriver({
          enabled: true,
          running: false,
          failure: new CuaDriver.CuaDriverHostError({
            operation: "desktop",
            cause: "Allow it.",
            block,
          }),
        });
        const leases = fakeLeases({});
        assert.deepEqual(yield* decide(driver, { leases: leases.leases }), {
          _tag: "none",
          reason: "not-granted",
          block,
          blockUserConfig: false,
        });
        // The session list shows the turn as waiting for the grant.
        assert.deepEqual(leases.blocked, [{ threadId: "thread-cua", block }]);
      }),
  );

  it.effect.each(["codex", "fx"])(
    "gives an unattended %s turn nothing without a lease, and blocks a user's driver",
    (provider) =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        assert.deepEqual(
          yield* decide(driver, { driver: ProviderDriverKind.make(provider), origin: unattended }),
          {
            _tag: "none",
            reason: "needs-approval",
            blockUserConfig: true,
          },
        );
        // The daemon is not started for a turn that cannot use it.
        assert.equal(driver.calls.acquire, 0);
        // Every other refusal of an unattended turn still blocks a user-defined server.
        assert.deepEqual(
          yield* decide(fakeDriver({ enabled: false, running: true }), {
            driver: ProviderDriverKind.make(provider),
            origin: unattended,
          }),
          { _tag: "none", reason: "disabled", blockUserConfig: true },
        );
      }),
  );

  it.effect.each(["codex", "fx"])(
    "routes a leased unattended %s turn through the proxy, failing closed without one",
    (provider) =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        const leased = fakeLeases({ grant: lease });
        const attached = yield* decide(driver, {
          driver: ProviderDriverKind.make(provider),
          origin: unattended,
          leases: leased.leases,
        });
        if (attached._tag !== "proxied") throw new Error("expected proxy attachment");
        assert.deepEqual(attached, {
          _tag: "proxied",
          mcp,
          attachmentGeneration: attached.attachmentGeneration,
          control: {
            controlId: "control:unattended",
            threadId: lease.threadId,
            expiresAt: lease.expiresAt,
            handoffId: lease.handoffId,
          },
          proxy,
          overrideUserConfig: true,
          skills: ["computer-use", "screen-code"],
        });
        assert.deepEqual(leased.minted, [Option.some(lease)]);
        assert.deepEqual(
          yield* decide(driver, {
            driver: ProviderDriverKind.make(provider),
            origin: unattended,
            leases: fakeLeases({ grant: lease, proxy: undefined }).leases,
          }),
          { _tag: "none", reason: "unavailable", blockUserConfig: true },
        );
      }),
  );

  it("replaces the session's previous driver with exactly the decision's", () => {
    const detached = ComputerUse.withComputerUse(
      { ...session, cuaDriver: mcp, cuaDriverOverridesUserConfig: true },
      { _tag: "none", reason: "plan", blockUserConfig: false },
      ROUTE,
    );
    assert.isFalse("cuaDriver" in detached);
    assert.isFalse("cuaDriverOverridesUserConfig" in detached);
    assert.isFalse("cuaDriverBlocked" in detached);
    const attached = ComputerUse.withComputerUse(
      detached,
      {
        _tag: "proxied",
        mcp,
        control: interactiveControl,
        proxy,
        proxyChannelToken: "fixture-channel-token",
        attachmentGeneration: "fixture-generation",
        overrideUserConfig: true,
        skills: ["computer-use"],
      },
      ROUTE,
    );
    assert.equal(attached.cuaDriver?.command, "/goat/node");
    assert.isTrue(attached.cuaDriverOverridesUserConfig);
    const blocked = ComputerUse.withComputerUse(
      attached,
      { _tag: "none", reason: "needs-approval", blockUserConfig: true },
      ROUTE,
    );
    assert.isFalse("cuaDriver" in blocked);
    assert.isTrue(blocked.cuaDriverBlocked);
  });

  it("keeps a browser screen guide when desktop control is detached", () => {
    const config = ComputerUse.withComputerUse(
      { ...session, builtInSkills: ["screen-code"] },
      { _tag: "none", reason: "plan", blockUserConfig: false },
      ROUTE,
    );
    assert.deepEqual(config.builtInSkills, ["screen-code"]);
  });

  it.effect(
    "tells the proxy the X display the driver was started on, so it can check every window",
    () =>
      Effect.gen(function* () {
        const display = { DISPLAY: ":96", XAUTHORITY: "/run/user/1000/xauth" };
        const driver = fakeDriver({ enabled: true, running: true, x11Display: display });
        const attached = yield* decide(driver, { leases: fakeLeases({}).leases });
        assert.deepInclude(attached, { _tag: "proxied", x11Display: display });
        const config = ComputerUse.withComputerUse(session, attached, ROUTE);
        assert.deepInclude(config.cuaDriver?.environment ?? [], {
          name: "GOAT_CUA_X11_DISPLAY",
          value: JSON.stringify(display),
        });
      }),
  );

  it("hands a turn the proxy with its control, credential and driver, never the raw driver", () => {
    const leased = ComputerUse.withComputerUse(
      session,
      {
        _tag: "proxied",
        mcp,
        control: { ...interactiveControl, controlId: "control:unattended" },
        proxy,
        proxyChannelToken: "fixture-channel-token",
        attachmentGeneration: "fixture-generation",
        overrideUserConfig: true,
        skills: ["computer-use"],
      },
      ROUTE,
    );
    assert.isTrue(leased.cuaDriverOverridesUserConfig);
    assert.deepEqual(leased.cuaDriver, {
      command: "/goat/node",
      args: [
        "/goat/bin.mjs",
        "cua-lease-proxy",
        "--thread",
        "thread-cua",
        "--driver-fingerprint",
        "c92dbd15a4346d598492ae617191d83ff9a12ebe91406e454fa3e7009b8401d7",
      ],
      environment: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "GOAT_CUA_LEASE_URL", value: "http://127.0.0.1:4100/api/computer-use/lease" },
        { name: "GOAT_CUA_LEASE_AUTHORIZATION", value: "Bearer fixture" },
        { name: "GOAT_CUA_DRIVER_MCP", value: JSON.stringify(mcp) },
        { name: "GOAT_CUA_PROXY_CHANNEL_TOKEN", value: "fixture-channel-token" },
      ],
      socketPath: "/tmp/cua.sock",
    });
  });
});
