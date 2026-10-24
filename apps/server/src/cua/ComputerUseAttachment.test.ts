import { assert, describe, it } from "@effect/vitest";
import {
  type CuaDriverMcpConfiguration,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ComputerUse from "./ComputerUseAttachment.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
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
}) => {
  const minted: Array<Option.Option<ComputerUseLeases.ComputerUseLease>> = [];
  const service = ComputerUseLeases.ComputerUseLeases.of({
    active: () => Effect.succeed(Option.fromNullishOr(input.grant)),
    holder: () => Effect.die("unused"),
    channelOrigin: () => Effect.die("unused"),
    state: () => Effect.die("unused"),
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
    controlState: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    stopAll: Effect.die("unused"),
    turnEnded: () => Effect.die("unused"),
    settle: Effect.die("unused"),
    disable: Effect.die("unused"),
    grants: Effect.die("unused"),
    pause: () => Effect.die("unused"),
    detection: Effect.succeed(input.detection ?? { humanInput: true, privateMode: true }),
    resume: Effect.die("unused"),
    sessions: Effect.die("unused"),
    subscribe: Effect.die("unused"),
    changed: Effect.die("unused"),
    proxy: "proxy" in input ? input.proxy : proxy,
  });
  return { leases: Option.some(service), minted };
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
    lastFailure: Effect.succeed(Option.none()),
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
  it.effect("routes an interactive local provider thread through the proxy under a control", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      const leases = fakeLeases({});
      assert.deepEqual(yield* decide(driver, { leases: leases.leases }), {
        _tag: "proxied",
        mcp,
        control: interactiveControl,
        proxy,
        // A cua-driver the person configured would skip Stop, pauses and app approvals.
        overrideUserConfig: true,
        skills: ["computer-use"],
      });
      assert.equal(driver.calls.acquire, 1);
      // An interactive control is not tied to a grant, even when the thread holds one.
      assert.deepEqual(leases.minted, [Option.none()]);
    }),
  );

  it.effect("keeps the tools but drops the skill the person switched off in Settings", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      const attached = yield* decide(driver, { leases: fakeLeases({}).leases }).pipe(
        Effect.provide(
          ServerSettings.ServerSettingsService.layerTest({
            disabledBuiltInSkills: ["computer-use", "skill-from-a-newer-build"],
          }),
        ),
      );
      assert.deepEqual(attached._tag === "proxied" ? attached.skills : null, []);
      const config = ComputerUse.withComputerUse(session, attached, ROUTE);
      assert.isDefined(config.cuaDriver);
      assert.isFalse(McpProviderSession.carriesComputerUseSkill(config));
      const defaults = yield* decide(driver, { leases: fakeLeases({}).leases });
      assert.isTrue(
        McpProviderSession.carriesComputerUseSkill(
          ComputerUse.withComputerUse(session, defaults, ROUTE),
        ),
      );
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
        assert.deepEqual(yield* skillsFor(["computer-use"]), ["computer-use"]);
        assert.deepEqual(yield* skillsFor(["browser"]), []);
      }),
  );

  it.effect(
    "refuses unattended work on a host that cannot detect a person's input or a secret field",
    () =>
      Effect.gen(function* () {
        const driver = fakeDriver({ enabled: true, running: true });
        for (const detection of [
          { humanInput: false, privateMode: true },
          { humanInput: true, privateMode: false },
        ])
          assert.deepEqual(
            yield* decide(driver, {
              origin: unattended,
              leases: fakeLeases({ grant: lease, detection }).leases,
            }),
            { _tag: "none", reason: "detection-unsupported", blockUserConfig: true },
          );
        // A person directing the thread can watch and stop it, so interactive turns still attach.
        assert.equal(
          (yield* decide(driver, {
            leases: fakeLeases({ detection: { humanInput: false, privateMode: false } }).leases,
          }))._tag,
          "proxied",
        );
        assert.equal(driver.calls.acquire, 1);
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

  it.effect("refuses plan, read-only, disabled and cloud threads without starting the driver", () =>
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
        assert.deepEqual(yield* decide(driver, overrides), {
          _tag: "none",
          reason,
          blockUserConfig: false,
        });
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

  it.effect("gives an unattended turn nothing without a lease, and blocks a user's driver", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      assert.deepEqual(yield* decide(driver, { origin: unattended }), {
        _tag: "none",
        reason: "needs-approval",
        blockUserConfig: true,
      });
      // The daemon is not started for a turn that cannot use it.
      assert.equal(driver.calls.acquire, 0);
      // Every other refusal of an unattended turn still blocks a user-defined server.
      assert.deepEqual(
        yield* decide(fakeDriver({ enabled: false, running: true }), { origin: unattended }),
        { _tag: "none", reason: "disabled", blockUserConfig: true },
      );
    }),
  );

  it.effect("routes a leased unattended turn through the proxy, failing closed without one", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      const leased = fakeLeases({ grant: lease });
      assert.deepEqual(yield* decide(driver, { origin: unattended, leases: leased.leases }), {
        _tag: "proxied",
        mcp,
        control: {
          controlId: "control:unattended",
          threadId: lease.threadId,
          expiresAt: lease.expiresAt,
          handoffId: lease.handoffId,
        },
        proxy,
        overrideUserConfig: true,
        skills: ["computer-use"],
      });
      assert.deepEqual(leased.minted, [Option.some(lease)]);
      assert.deepEqual(
        yield* decide(driver, {
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
        "--control",
        "control:unattended",
        "--expires",
        "2026-10-21T13:00:00.000Z",
      ],
      environment: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "GOAT_CUA_LEASE_URL", value: "http://127.0.0.1:4100/api/computer-use/lease" },
        { name: "GOAT_CUA_LEASE_AUTHORIZATION", value: "Bearer fixture" },
        { name: "GOAT_CUA_DRIVER_MCP", value: JSON.stringify(mcp) },
      ],
      socketPath: "/tmp/cua.sock",
    });
  });
});
