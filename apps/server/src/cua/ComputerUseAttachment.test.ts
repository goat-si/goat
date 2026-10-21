import { assert, describe, it } from "@effect/vitest";
import {
  type CuaDriverMcpConfiguration,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ComputerUse from "./ComputerUseAttachment.ts";
import * as CuaDriver from "./CuaDriver.ts";

const mcp: CuaDriverMcpConfiguration = {
  command: "/driver/cua-driver",
  args: ["mcp", "--socket", "/tmp/cua.sock"],
  environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
  socketPath: "/tmp/cua.sock",
};

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
  });
  return { service: Option.some(service), calls };
};

const decide = (
  driver: ReturnType<typeof fakeDriver>,
  overrides: Partial<ComputerUse.ComputerUseAttachmentInput> = {},
) =>
  ComputerUse.computerUseAttachment(driver.service, {
    threadId: ThreadId.make("thread-cua"),
    driver: ProviderDriverKind.make("codex"),
    interactionMode: "default",
    readOnly: false,
    ...overrides,
  });

describe("computerUseAttachment", () => {
  it.effect("attaches the running driver to an interactive local provider thread", () =>
    Effect.gen(function* () {
      const driver = fakeDriver({ enabled: true, running: true });
      assert.deepEqual(yield* decide(driver), {
        _tag: "direct",
        mcp,
        overrideUserConfig: false,
      });
      assert.equal(driver.calls.acquire, 1);
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
        assert.deepEqual(yield* decide(driver, overrides), { _tag: "none", reason });
        assert.equal(driver.calls.acquire, 0, reason);
      }
      assert.deepEqual(
        yield* ComputerUse.computerUseAttachment(Option.none(), {
          threadId: ThreadId.make("thread-cua"),
          driver: ProviderDriverKind.make("codex"),
          interactionMode: "default",
          readOnly: false,
        }),
        { _tag: "none", reason: "disabled" },
      );
    }),
  );

  it.effect("reports an enabled driver that did not start as unavailable", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* decide(fakeDriver({ enabled: true, running: false })), {
        _tag: "none",
        reason: "unavailable",
      });
    }),
  );

  it("replaces the session's previous driver with exactly the decision's", () => {
    const session: McpProviderSessionConfig = {
      environmentId: EnvironmentId.make("environment-cua"),
      threadId: ThreadId.make("thread-cua"),
      providerSessionId: "credential",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer fixture",
      browserToolsAvailable: false,
      cuaDriver: mcp,
      cuaDriverOverridesUserConfig: true,
    };
    const detached = ComputerUse.withComputerUse(session, { _tag: "none", reason: "plan" });
    assert.isFalse("cuaDriver" in detached);
    assert.isFalse("cuaDriverOverridesUserConfig" in detached);
    const attached = ComputerUse.withComputerUse(detached, {
      _tag: "direct",
      mcp,
      overrideUserConfig: false,
    });
    assert.deepEqual(attached.cuaDriver, mcp);
    assert.isFalse("cuaDriverOverridesUserConfig" in attached);
  });
});
