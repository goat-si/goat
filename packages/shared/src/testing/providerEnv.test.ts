import { describe, expect, it } from "vite-plus/test";

import { removeAmbientProviderEnv } from "./providerEnv.ts";

describe("removeAmbientProviderEnv", () => {
  it("drops the variables a GOAT thread injects and keeps CI and opt-in test knobs (#1092)", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      GOAT_ACP_MCP_ENDPOINT: "http://127.0.0.1:3773/mcp",
      GOAT_ACP_MCP_AUTHORIZATION: "Bearer thread-token",
      GOAT_CLI_PATH: "/home/user/.goat/desktop/bin/goat",
      GOAT_HOME: "/home/user/.goat/desktop",
      T3CODE_CLI_PATH: "/home/user/.goat/desktop/bin/goat",
      ANTHROPIC_AUTH_TOKEN: "secret",
      GOAT_TEST_TMP_GUARD: "fail",
      GOAT_TEST_PARENT_TMPDIR: "/tmp/goat-ci",
      GOAT_TEST_HEADLESS_SHELL: "/opt/chrome-headless-shell",
      GOAT_MEMORY_GROWTH: "1",
      GOAT_TRANSFER_BUDGET_REPORT_PATH: "/tmp/report.md",
    };
    removeAmbientProviderEnv(env);
    expect(env).toEqual({
      PATH: "/usr/bin",
      GOAT_TEST_TMP_GUARD: "fail",
      GOAT_TEST_PARENT_TMPDIR: "/tmp/goat-ci",
      GOAT_TEST_HEADLESS_SHELL: "/opt/chrome-headless-shell",
      GOAT_MEMORY_GROWTH: "1",
      GOAT_TRANSFER_BUDGET_REPORT_PATH: "/tmp/report.md",
    });
  });

  it("keeps everything when a live run opts out", () => {
    const env: NodeJS.ProcessEnv = {
      GOAT_TEST_KEEP_PROVIDER_ENV: "1",
      GOAT_ACP_MCP_AUTHORIZATION: "Bearer thread-token",
      ANTHROPIC_AUTH_TOKEN: "secret",
    };
    removeAmbientProviderEnv(env);
    expect(env).toEqual({
      GOAT_TEST_KEEP_PROVIDER_ENV: "1",
      GOAT_ACP_MCP_AUTHORIZATION: "Bearer thread-token",
      ANTHROPIC_AUTH_TOKEN: "secret",
    });
  });
});
