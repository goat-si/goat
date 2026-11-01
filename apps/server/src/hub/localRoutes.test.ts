import { expect, it } from "@effect/vitest";
import { ProviderInstanceConfigMap, ServerProvider } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { localOpenCodexRoutes } from "./localRoutes.ts";

const decodeInstances = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const HOME = "http://127.0.0.1:10100/v1";

it.each(["claudeAgent", "opencode", "pi"])(
  "reports %s Home wiring only from a ready runtime snapshot that uses the local listener",
  (driver) => {
    const instances = decodeInstances({
      target: { driver, config: { modelRoute: "opencodex", opencodexBaseUrl: HOME } },
    });
    const provider = decodeProvider({
      instanceId: "target",
      driver,
      enabled: true,
      installed: true,
      version: "fixture",
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: "2026-10-27T00:00:00.000Z",
      models: [],
      homeRoute: { modelRoute: "opencodex", effectiveBaseUrl: HOME },
    });
    const input = { instances, environment: {}, port: 10100 };
    const status = (providers: ReadonlyArray<ServerProvider>, port = 10100) =>
      localOpenCodexRoutes({ ...input, port, providers })[0]?.status;
    expect(status([provider])).toBe("ok");
    expect(status([])).toBe("unproven");
    expect(status([{ ...provider, status: "error" }])).toBe("unproven");
    expect(status([provider], 10101)).toBe("unproven");
  },
);

it("does not prove Pi wiring from a configured agent directory alone", () => {
  const instances = decodeInstances({
    pi: {
      driver: "pi",
      environment: [{ name: "PI_CODING_AGENT_DIR", value: "/fixture/user-pi" }],
    },
  });
  expect(
    localOpenCodexRoutes({ instances, providers: [], environment: {}, port: 10100 }),
  ).toMatchObject([{ instanceId: "pi", driver: "pi", status: "unproven" }]);
});
