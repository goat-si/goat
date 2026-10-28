// @effect-diagnostics nodeBuiltinImport:off -- Artifact acceptance exercises the standalone build command.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const script = NodeURL.fileURLToPath(new URL("./connect-hosted-artifact.ts", import.meta.url));
const headers = NodeURL.fileURLToPath(new URL("../infra/connect-hosted/_headers", import.meta.url));
it("staging and production artifacts bind distinct bytes/configuration and refuse mixed-origin promotion", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-hosted-artifact-"));
  try {
    await NodeFSP.mkdir(NodePath.join(directory, "apps/web/dist"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(directory, "infra/connect-hosted"), { recursive: true });
    await NodeFSP.copyFile(headers, NodePath.join(directory, "infra/connect-hosted/_headers"));
    const build = async (stage: string, origin: string) => {
      await NodeFSP.writeFile(
        NodePath.join(directory, "apps/web/dist/index.html"),
        `<html>${origin}</html>`,
      );
      return execute(process.execPath, [script, stage], {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          CONNECT_SOURCE_SHA: "a".repeat(40),
          GOAT_HOSTED_APP_URL: origin,
          VITE_HOSTED_APP_URL: origin,
          GOAT_CLERK_PUBLISHABLE_KEY: "pk_live_test",
          GOAT_CLERK_CLI_OAUTH_CLIENT_ID: "cli-client",
          GOAT_RELAY_URL: "https://relay.example.test",
        },
      });
    };
    const staging = JSON.parse((await build("staging", "https://staging.app.trygoat.ai")).stdout);
    const production = JSON.parse((await build("production", "https://app.trygoat.ai")).stdout);
    expect(staging.sourceSha).toBe(production.sourceSha);
    expect(staging.artifactDigest).not.toBe(production.artifactDigest);
    const manifest = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(directory, "apps/web/dist/connect-artifact.json"),
        "utf8",
      ),
    );
    expect(manifest.publicConfig.hostedAppUrl).toBe("https://app.trygoat.ai");
    expect(manifest.files.some((file: { name: string }) => file.name === "_headers")).toBe(true);
    await expect(build("production", "https://staging.app.trygoat.ai")).rejects.toThrow();
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
