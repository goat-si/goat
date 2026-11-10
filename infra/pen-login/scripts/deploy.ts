// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A standalone deploy script.
// Deploys pen-login with its secrets in the same version, so the Worker never runs without them.
// Usage: node scripts/deploy.ts <google-oauth-client.json>
// The client file is Google's download ({"web":{...}}) or {"client_id","client_secret"}. LOGIN_SIGNING_KEY is
// generated only when the Worker has none: a new login key would orphan every mesh bound to the old one.
// Prints secret names, never values.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const CALLBACK = "https://pen-login.pos090001.workers.dev/v1/auth/google/callback";
const wrangler = process.env.PEN_WRANGLER ?? "wrangler";

function fail(message: string): never {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

const clientPath = process.argv[2];
if (!clientPath) fail("usage: node scripts/deploy.ts <google-oauth-client.json>");

let parsed: unknown;
try {
  parsed = JSON.parse(NodeFS.readFileSync(clientPath, "utf8"));
} catch (error) {
  fail(`cannot read ${clientPath}: ${error instanceof Error ? error.name : "error"}`);
}
const outer = (parsed ?? {}) as Record<string, unknown>;
const client = (outer.web ?? outer) as Record<string, unknown>;
const clientId = client.client_id;
const clientSecret = client.client_secret;
if (typeof clientId !== "string" || !clientId.endsWith(".apps.googleusercontent.com")) {
  fail("client_id is missing or is not a Google web client id");
}
if (typeof clientSecret !== "string" || clientSecret.length === 0) fail("client_secret is missing");
const redirects = client.redirect_uris;
if (Array.isArray(redirects) && !redirects.includes(CALLBACK)) {
  fail(`the client's redirect_uris do not include ${CALLBACK}`);
}

const list = NodeChildProcess.spawnSync(wrangler, ["secret", "list", "--format", "json"], {
  encoding: "utf8",
});
let existing: string[] = [];
if (list.status === 0) {
  existing = (JSON.parse(list.stdout) as { name: string }[]).map((s) => s.name);
} else if (!/not found|10007/i.test(list.stdout + list.stderr)) {
  fail(`wrangler secret list failed (exit ${list.status}); is wrangler signed in?`);
}

const secrets: Record<string, string> = {
  GOOGLE_CLIENT_ID: clientId,
  GOOGLE_CLIENT_SECRET: clientSecret,
};
if (!existing.includes("LOGIN_SIGNING_KEY")) {
  secrets.LOGIN_SIGNING_KEY = NodeCrypto.randomBytes(32).toString("base64url");
}

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-login-"));
let status: number | null = 1;
try {
  const file = NodePath.join(dir, "secrets.json");
  NodeFS.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  status = NodeChildProcess.spawnSync(wrangler, ["deploy", "--secrets-file", file], {
    stdio: "inherit",
  }).status;
} finally {
  NodeFS.rmSync(dir, { recursive: true, force: true });
}
console.log(
  `deploy: secrets sent: ${Object.keys(secrets).join(", ")}${secrets.LOGIN_SIGNING_KEY ? "" : " (LOGIN_SIGNING_KEY kept)"}`,
);
process.exit(status ?? 1);
