// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A standalone deploy script.
// Deploys pen-login with its secrets in the same version, so the Worker never runs without them.
// Usage: node scripts/deploy.ts <google-oauth-client.json> [--signing-key-file <path>]
// The client file is Google's download ({"web":{...}}) or {"client_id","client_secret"}. LOGIN_SIGNING_KEY is
// sent only when the Worker has none, from --signing-key-file: an existing file restores its key, a missing one is
// created (0600, in a 0700 directory outside the repository) with a new key. The Worker secret cannot be read
// back and a new login key orphans every mesh bound to the old one, so that file is the only copy.
// Prints secret names and the login key's kid, never values.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { signingKeyFromSeed } from "@goat/pen-protocol/identity";
import { loginKid } from "@goat/pen-protocol/login";

const CALLBACK = "https://pen-login.pos090001.workers.dev/v1/auth/google/callback";
const wrangler = process.env.PEN_WRANGLER ?? "wrangler";
const REPO = NodePath.resolve(import.meta.dirname, "../../..");

function fail(message: string): never {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

const USAGE =
  "usage: node scripts/deploy.ts <google-oauth-client.json> [--signing-key-file <path>]";
const [clientPath, ...rest] = process.argv.slice(2);
if (!clientPath) fail(USAGE);
let keyFile: string | undefined;
if (rest.length === 2 && rest[0] === "--signing-key-file" && rest[1])
  keyFile = NodePath.resolve(rest[1]);
else if (rest.length > 0) fail(USAGE);

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
} else if (!/\b10007\b|Worker .*does not exist/i.test(list.stdout + list.stderr)) {
  // Only a Worker that does not exist yet (Cloudflare error 10007) has no secrets; any other failure
  // (sign-in, account, network) must not read as "no LOGIN_SIGNING_KEY", which would create one.
  fail(`wrangler secret list failed (exit ${list.status}); is wrangler signed in?`);
}

const secrets: Record<string, string> = {
  GOOGLE_CLIENT_ID: clientId,
  GOOGLE_CLIENT_SECRET: clientSecret,
};
if (existing.includes("LOGIN_SIGNING_KEY")) {
  if (keyFile) {
    fail(
      "the Worker already has LOGIN_SIGNING_KEY; replacing it orphans every bound mesh. Delete the secret first if that is meant (docs/operations/pen.md).",
    );
  }
} else {
  if (!keyFile) {
    fail(
      "the Worker has no LOGIN_SIGNING_KEY: pass --signing-key-file <path> to restore a kept key or create one there.",
    );
  }
  secrets.LOGIN_SIGNING_KEY = await keyFromFile(keyFile);
  const key = await signingKeyFromSeed(Buffer.from(secrets.LOGIN_SIGNING_KEY, "base64url"));
  console.log(`deploy: login key kid ${await loginKid(key.signPub)} from ${keyFile}`);
}

/** Reads the seed kept at path, or creates it there; the directory must be private and outside the repository. */
async function keyFromFile(path: string): Promise<string> {
  const parent = NodePath.dirname(path);
  let mode: number;
  let realParent: string;
  try {
    mode = NodeFS.statSync(parent).mode & 0o777;
    realParent = NodeFS.realpathSync(parent);
  } catch {
    fail(`${parent} does not exist`);
  }
  const fromRepo = NodePath.relative(NodeFS.realpathSync(REPO), realParent);
  if (!fromRepo.startsWith("..") && !NodePath.isAbsolute(fromRepo)) {
    fail(`${path} is inside the repository (${realParent}); keep the login key outside it`);
  }
  if (mode & 0o077)
    fail(`${parent} is open to other users (mode ${mode.toString(8)}); use a 0700 directory`);
  if (NodeFS.existsSync(path)) {
    const seed = NodeFS.readFileSync(path, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(seed) || Buffer.from(seed, "base64url").length !== 32) {
      fail(`${path} does not hold a base64url 32-byte seed`);
    }
    return seed;
  }
  const seed = NodeCrypto.randomBytes(32).toString("base64url");
  NodeFS.writeFileSync(path, seed + "\n", { mode: 0o600, flag: "wx" });
  return seed;
}

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-login-"));
const removeSecrets = () => NodeFS.rmSync(dir, { recursive: true, force: true });
// Ctrl-C reaches wrangler too; keep this process alive until it returns, so the secrets file goes.
const interrupted = () => {};
process.on("SIGINT", interrupted);
process.on("SIGTERM", interrupted);
let status: number | null = 1;
try {
  const file = NodePath.join(dir, "secrets.json");
  NodeFS.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  status = NodeChildProcess.spawnSync(wrangler, ["deploy", "--secrets-file", file], {
    stdio: "inherit",
  }).status;
} finally {
  removeSecrets();
}
if (status !== 0) {
  fail(
    `wrangler deploy failed (exit ${status}); check pnpm exec wrangler secret list, then run this again (a key file it created is reused)`,
  );
}
console.log(
  `deploy: secrets sent: ${Object.keys(secrets).join(", ")}${secrets.LOGIN_SIGNING_KEY ? "" : " (LOGIN_SIGNING_KEY kept)"}`,
);
process.exit(0);
