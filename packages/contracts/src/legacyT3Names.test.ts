import { describe, expect, it } from "vite-plus/test";

import {
  adoptLegacyEnv,
  goatEnvName,
  legacyEnvName,
  normalizeLegacyEnv,
  withLegacyEnvAliases,
  withLegacyEnvNames,
} from "./legacyT3Names.ts";

describe("legacy env names", () => {
  it("maps every legacy prefix and the irregular names both ways", () => {
    expect(goatEnvName("T3CODE_HOME")).toBe("GOAT_HOME");
    expect(goatEnvName("T3_MCP_URL")).toBe("GOAT_MCP_URL");
    expect(goatEnvName("T3_CODE_MCP_AUTHORIZATION")).toBe("GOAT_MCP_AUTHORIZATION");
    expect(goatEnvName("VITE_T3CODE_WEB_SOURCEMAP")).toBe("VITE_GOAT_WEB_SOURCEMAP");
    expect(goatEnvName("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH")).toBe(
      "GOAT_DEV_REMOTE_SERVER_ENTRY_PATH",
    );
    expect(legacyEnvName("GOAT_HOME")).toBe("T3CODE_HOME");
    expect(legacyEnvName("GOAT_MCP_AUTHORIZATION")).toBe("T3_CODE_MCP_AUTHORIZATION");
    expect(legacyEnvName("PATH")).toBeUndefined();
  });

  it("aliases relay keys and leaves the hosted web routing keys alone", () => {
    expect(goatEnvName("T3CODE_RELAY_URL")).toBe("GOAT_RELAY_URL");
    expect(goatEnvName("VITE_T3CODE_RELAY_URL")).toBe("VITE_GOAT_RELAY_URL");
    expect(goatEnvName("T3CODE_CLERK_PUBLISHABLE_KEY")).toBe("GOAT_CLERK_PUBLISHABLE_KEY");
    expect(goatEnvName("T3CODE_WEB_ROUTER_URL")).toBeUndefined();
  });
});

describe("adoptLegacyEnv", () => {
  it("fills unset GOAT names, keeps explicit ones and the legacy originals", () => {
    const env: Record<string, string | undefined> = {
      T3CODE_HOME: "/old",
      T3CODE_PORT: "1",
      GOAT_PORT: "2",
      T3_MCP_URL: "http://mcp",
    };
    adoptLegacyEnv(env);
    expect(env).toEqual({
      T3CODE_HOME: "/old",
      GOAT_HOME: "/old",
      T3CODE_PORT: "1",
      GOAT_PORT: "2",
      T3_MCP_URL: "http://mcp",
      GOAT_MCP_URL: "http://mcp",
    });
  });

  it("prefers T3CODE_ when two legacy names map to one GOAT name", () => {
    const env: Record<string, string | undefined> = { T3_FOO: "short", T3CODE_FOO: "long" };
    expect(withLegacyEnvAliases(env).GOAT_FOO).toBe("long");
  });
});

describe("normalizeLegacyEnv", () => {
  it("moves legacy values to GOAT names so deleting the GOAT name unsets the variable", () => {
    const env: Record<string, string | undefined> = {
      T3CODE_HOME: "/old",
      T3CODE_WEB_ROUTER_URL: "https://router",
      PATH: "/bin",
    };
    normalizeLegacyEnv(env);
    expect(env).toEqual({
      GOAT_HOME: "/old",
      T3CODE_WEB_ROUTER_URL: "https://router",
      PATH: "/bin",
    });
    delete env.GOAT_HOME;
    expect(withLegacyEnvAliases(env).GOAT_HOME).toBeUndefined();
  });
});

describe("withLegacyEnvNames", () => {
  it("adds the legacy spelling older builds read", () => {
    expect(
      withLegacyEnvNames({ GOAT_HOME: "/h", GOAT_SSH_AUTH_SECRET: "s", PATH: "/bin" }),
    ).toEqual({
      GOAT_HOME: "/h",
      T3CODE_HOME: "/h",
      GOAT_SSH_AUTH_SECRET: "s",
      T3_SSH_AUTH_SECRET: "s",
      PATH: "/bin",
    });
  });

  it("hands older builds the GOAT value when both spellings disagree", () => {
    const env = withLegacyEnvNames({ GOAT_HOME: "/new", T3CODE_HOME: "/old" }); // goat-rename: legacy
    expect(env.T3CODE_HOME).toBe("/new"); // goat-rename: legacy
  });
});
