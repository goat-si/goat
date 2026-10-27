// @effect-diagnostics nodeBuiltinImport:off -- Build manifest runs before the application runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const stage = process.argv[2];
if (stage !== "staging" && stage !== "production")
  throw new Error("Expected staging or production");
const origin = stage === "staging" ? "https://staging.app.trygoat.ai" : "https://app.trygoat.ai";
if (process.env.GOAT_HOSTED_APP_URL !== origin || process.env.VITE_HOSTED_APP_URL !== origin)
  throw new Error("Hosted artifact must be built for its exact deployment origin");
const sourceSha = process.env.CONNECT_SOURCE_SHA;
if (!sourceSha || !/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error("Missing source SHA");
const publicConfig = {
  hostedAppUrl: origin,
  clerkPublishableKey: process.env.GOAT_CLERK_PUBLISHABLE_KEY,
  clerkCliOAuthClientId: process.env.GOAT_CLERK_CLI_OAUTH_CLIENT_ID,
  relayUrl: process.env.GOAT_RELAY_URL,
};
if (Object.values(publicConfig).some((value) => !value))
  throw new Error("Incomplete public configuration");
if (stage === "production" && !publicConfig.clerkPublishableKey?.startsWith("pk_live_"))
  throw new Error("Production requires a live Clerk instance");
const root = "apps/web/dist";
await NodeFSP.copyFile("infra/connect-hosted/_headers", NodePath.join(root, "_headers"));
const entries = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile())
  .map((entry) => NodePath.relative(root, NodePath.join(entry.parentPath, entry.name)))
  .filter((name) => name !== "connect-artifact.json")
  .sort();
const digests = await Promise.all(
  files.map(async (name) => ({
    name,
    sha256: NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(NodePath.join(root, name)))
      .digest("hex"),
  })),
);
const artifactDigest = NodeCrypto.createHash("sha256")
  .update(JSON.stringify(digests))
  .digest("hex");
await NodeFSP.writeFile(
  NodePath.join(root, "connect-artifact.json"),
  JSON.stringify(
    {
      sourceSha,
      stage,
      publicConfig,
      artifactDigest,
      files: digests,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ sourceSha, stage, origin, artifactDigest, publicConfig }));
