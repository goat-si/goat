// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "GOAT_CLERK_PUBLISHABLE_KEY=pk_root\nGOAT_CLERK_JWT_TEMPLATE=template_root\nGOAT_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nGOAT_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "GOAT_CLERK_PUBLISHABLE_KEY=pk_local\nGOAT_CLERK_JWT_TEMPLATE=template_local\nGOAT_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nGOAT_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).GOAT_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          GOAT_CLERK_PUBLISHABLE_KEY: "pk_ci",
          GOAT_CLERK_JWT_TEMPLATE: "template_ci",
          GOAT_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          GOAT_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      GOAT_CLERK_PUBLISHABLE_KEY: "pk_ci",
      GOAT_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      GOAT_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      GOAT_RELAY_URL: "https://ci.example.test",
      VITE_GOAT_RELAY_URL: "https://ci.example.test",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
