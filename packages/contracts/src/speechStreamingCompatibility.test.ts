import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ServerConfig as PreviousServerConfig } from "./serverConfig.base-fixture.ts";
import { ServerConfig } from "./server.ts";

const decodePrevious = Schema.decodeUnknownSync(PreviousServerConfig);
const decodeCurrent = Schema.decodeUnknownSync(ServerConfig);

const oldWire = {
  environment: {
    environmentId: "fixture-environment",
    label: "Fixture",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: {},
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "fixture-session",
  },
  cwd: "/fixture",
  keybindingsConfigPath: "/fixture/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/fixture/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: {},
};

it("lets old and new peers decode server configuration with streaming capability", () => {
  const old = decodePrevious(oldWire);
  const current = decodeCurrent({ ...oldWire, speechStreamingV1: true });
  expect(current).toHaveProperty("speechStreamingV1", true);
  expect(decodePrevious({ ...oldWire, speechStreamingV1: true })).toEqual(old);
  expect(decodeCurrent(oldWire)).toEqual(old);
});

it("lets old peers ignore the server's streaming-capable model catalog", () => {
  const wire = { ...oldWire, speechStreamingV1: true, speechStreamingModelIds: ["fixture-model"] };
  expect(decodeCurrent(wire)).toHaveProperty("speechStreamingModelIds", ["fixture-model"]);
  expect(decodePrevious(wire)).toEqual(decodePrevious(oldWire));
});
