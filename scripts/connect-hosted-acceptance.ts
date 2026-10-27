// @effect-diagnostics nodeBuiltinImport:off -- Protected release gates bind human live-smoke evidence to deployed bytes.
import * as NodeFSP from "node:fs/promises";

const manifest = JSON.parse(
  process.env.CONNECT_EXPECTED_ARTIFACT ??
    (await NodeFSP.readFile("apps/web/dist/connect-artifact.json", "utf8")),
) as {
  sourceSha: string;
  stage: string;
  artifactDigest: string;
  publicConfig: { hostedAppUrl: string };
};
const raw = process.env.CONNECT_ACCEPTANCE_EVIDENCE;
if (!raw) throw new Error("Live browser/MFA/CLI evidence is required before admission");
const evidence = JSON.parse(raw) as Record<string, unknown>;
if (
  evidence.sourceSha !== manifest.sourceSha ||
  evidence.artifactDigest !== manifest.artifactDigest ||
  evidence.origin !== manifest.publicConfig.hostedAppUrl
)
  throw new Error("Live evidence must identify this exact source, artifact and origin");
for (const name of [
  "emptyStorageRoot",
  "deepLink",
  "freshMfa",
  "ownHostOnly",
  "normalCliApprovalAndCode",
]) {
  if (evidence[name] !== true) throw new Error(`Missing live acceptance: ${name}`);
}
if (manifest.stage === "production" && evidence.rejectedOrigin !== "https://staging.app.trygoat.ai")
  throw new Error("Production must reject staging at the loopback approval receiver");
if (typeof evidence.evidenceUrl !== "string" || new URL(evidence.evidenceUrl).protocol !== "https:")
  throw new Error("Live acceptance needs a durable evidence link");
console.log(
  JSON.stringify({
    sourceSha: manifest.sourceSha,
    artifactDigest: manifest.artifactDigest,
    origin: manifest.publicConfig.hostedAppUrl,
    evidenceUrl: evidence.evidenceUrl,
  }),
);
