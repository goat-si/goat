// @effect-diagnostics nodeBuiltinImport:off -- Release smoke compares deployed bytes with the build receipt.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

const manifest = JSON.parse(
  await NodeFSP.readFile("apps/web/dist/connect-artifact.json", "utf8"),
) as {
  sourceSha: string;
  artifactDigest: string;
  publicConfig: { hostedAppUrl: string };
  files: Array<{ name: string; sha256: string }>;
};
const origin = manifest.publicConfig.hostedAppUrl;
const deployed = await fetch(`${origin}/connect-artifact.json`, { cache: "no-store" });
if (!deployed.ok) throw new Error("Missing deployed build receipt");
const receipt = await deployed.json();
if (JSON.stringify(receipt) !== JSON.stringify(manifest))
  throw new Error("Deployed artifact/config differs from build");
for (const path of ["/", "/connect", "/settings/connections"]) {
  const response = await fetch(`${origin}${path}`, { cache: "no-store" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expected = manifest.files.find((entry) => entry.name === "index.html");
  if (
    !response.ok ||
    !expected ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw new Error(`Hosted SPA entry failed: ${path}`);
  if (!response.headers.get("cache-control")?.includes("no-store"))
    throw new Error("Hosted shell is cacheable");
}
console.log(
  JSON.stringify({
    sourceSha: manifest.sourceSha,
    artifactDigest: manifest.artifactDigest,
    origin,
    smoke: "root/deep-link/approval-entry",
  }),
);
