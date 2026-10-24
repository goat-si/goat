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
import * as ServerSettings from "../serverSettings.ts";
import type { ComputerUseLease } from "./ComputerUseLeases.ts";
import * as CuaDriver from "./CuaDriver.ts";

const mcp: CuaDriverMcpConfiguration = {
  command: "/driver/cua-driver",
  args: ["mcp", "--socket", "/tmp/cua.sock"],
  environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
  socketPath: "/tmp/cua.sock",
};

const lease: ComputerUseLease = {
  threadId: ThreadId.make("thread-cua"),
  handoffId: TurnItemId.make("handoff:grant"),
  expiresAt: DateTime.makeUnsafe("2026-10-21T12:30:00.000Z"),
};
const proxy = { command: "/goat/node", entrypoint: "/goat/bin.mjs" };
const ROUTE = "/api/computer-use/lease";

const fakeDriver = (input: { readonly enabled: boolean; readonly running: boolean }) => {
  const calls = { acquire: 0 };
  const service = CuaDriver.CuaDriver.of({
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
  lease: Option.none(),
  proxy,
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
  it.effect("attaches the running driver to an interactive local provider thread", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      assert.deepEqual(yield* decide(driver), {
        _tag: "direct",
        mcp,
        overrideUserConfig: false,
        skills: ["computer-use"],
      });
      assert.equal(driver.calls.acquire, 1);
    }),
  );

  it.effect("keeps the tools but drops the skill the person switched off in Settings", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      const attached = yield* decide(driver).pipe(
        Effect.provide(
          ServerSettings.ServerSettingsService.layerTest({
            disabledBuiltInSkills: ["computer-use", "skill-from-a-newer-build"],
          }),
        ),
      );
      assert.deepEqual(attached, { _tag: "direct", mcp, overrideUserConfig: false, skills: [] });
      const config = ComputerUse.withComputerUse(session, attached, ROUTE);
      assert.deepEqual(config.cuaDriver, mcp);
      assert.isFalse(McpProviderSession.carriesComputerUseSkill(config));
      assert.isTrue(
        McpProviderSession.carriesComputerUseSkill(
          ComputerUse.withComputerUse(session, yield* decide(driver), ROUTE),
        ),
      );
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
      assert.deepEqual(yield* decide(driver, { origin: unattended, lease: Option.some(lease) }), {
        _tag: "leased",
        mcp,
        lease,
        proxy,
        skills: ["computer-use"],
      });
      assert.deepEqual(
        yield* decide(driver, {
          origin: unattended,
          lease: Option.some(lease),
          proxy: undefined,
        }),
        { _tag: "none", reason: "unavailable", blockUserConfig: true },
      );
      // A lease means nothing to an interactive turn; it keeps the direct driver.
      assert.equal(
        (yield* decide(driver, { origin: interactive, lease: Option.some(lease) }))._tag,
        "direct",
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
      { _tag: "direct", mcp, overrideUserConfig: false, skills: ["computer-use"] },
      ROUTE,
    );
    assert.deepEqual(attached.cuaDriver, mcp);
    assert.isFalse("cuaDriverOverridesUserConfig" in attached);
    const blocked = ComputerUse.withComputerUse(
      attached,
      { _tag: "none", reason: "needs-approval", blockUserConfig: true },
      ROUTE,
    );
    assert.isFalse("cuaDriver" in blocked);
    assert.isTrue(blocked.cuaDriverBlocked);
  });

  it("hands a leased turn the proxy with its lease, credential and driver, never the raw driver", () => {
    const leased = ComputerUse.withComputerUse(
      session,
      { _tag: "leased", mcp, lease, proxy, skills: ["computer-use"] },
      ROUTE,
    );
    assert.isTrue(leased.cuaDriverOverridesUserConfig);
    assert.deepEqual(leased.cuaDriver, {
      command: "/goat/node",
      args: [
        "/goat/bin.mjs",
        "cua-lease-proxy",
        "--handoff",
        "handoff:grant",
        "--expires",
        "2026-10-21T12:30:00.000Z",
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
