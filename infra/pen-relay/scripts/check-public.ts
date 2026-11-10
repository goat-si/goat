// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A standalone pre-deploy check.
// Refuses to publish public/ when install.sh points at loopback or plain-http relays (a local test
// build, such as installcheck.sh used to leave) or names a version whose four archives are not all
// in dl/<version>/ with the sums SHA256SUMS lists (install.sh checks every download against them).
// Usage: node scripts/check-public.ts [public dir]
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const dir = process.argv[2] ?? NodePath.join(import.meta.dirname, "..", "public");
const problems: string[] = [];
const archives = [
  "pen-linux-amd64.gz",
  "pen-linux-arm64.gz",
  "pen-darwin-arm64.gz",
  "pen-darwin-amd64.gz",
];
const installPath = NodePath.join(dir, "install.sh");
let install = "";
try {
  install = NodeFS.readFileSync(installPath, "utf8");
} catch {
  problems.push(`${installPath} is missing; run apps/pen/scripts/build.sh first`);
}

/** The default an install.sh line assigns: NAME="${ENV:-default}". */
function defaultOf(name: string, env = name): string | undefined {
  return new RegExp(`^${name}="\\$\\{${env}:-([^}]*)\\}"$`, "m").exec(install)?.[1];
}

if (install) {
  const relays = [
    ...new Set([defaultOf("PEN_RELAY"), ...(defaultOf("PEN_RELAYS") ?? "").split(" ")]),
  ].filter((r): r is string => !!r);
  if (relays.length === 0) problems.push("install.sh names no relay");
  for (const relay of relays) {
    let url: URL | undefined;
    try {
      url = new URL(relay);
    } catch {
      problems.push(`install.sh relay ${relay} is not a URL`);
      continue;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:") problems.push(`install.sh relay ${relay} is not https`);
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      /^127\./.test(host) ||
      host === "::1"
    ) {
      problems.push(`install.sh relay ${relay} is a loopback address (a local test build)`);
    }
  }
  const version = defaultOf("VERSION", "PEN_VERSION");
  if (!version) problems.push("install.sh names no version");
  else checkArchives(version);
}

/** Every archive install.sh may fetch exists and matches its line in SHA256SUMS. */
function checkArchives(version: string) {
  const dl = NodePath.join(dir, "dl", version);
  let sums = "";
  try {
    sums = NodeFS.readFileSync(NodePath.join(dl, "SHA256SUMS"), "utf8");
  } catch {
    problems.push(`install.sh installs ${version}, but dl/${version}/SHA256SUMS is missing`);
    return;
  }
  const listed = new Map<string, string>();
  for (const line of sums.split("\n")) {
    const [, sum, name] = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim()) ?? [];
    if (sum && name) listed.set(name, sum);
  }
  for (const name of archives) {
    const want = listed.get(name);
    if (!want) {
      problems.push(`dl/${version}/SHA256SUMS does not list ${name}`);
      continue;
    }
    let body: Buffer;
    try {
      body = NodeFS.readFileSync(NodePath.join(dl, name));
    } catch {
      problems.push(`dl/${version}/${name} is missing`);
      continue;
    }
    if (NodeCrypto.createHash("sha256").update(body).digest("hex") !== want) {
      problems.push(`dl/${version}/${name} does not match its SHA256SUMS line`);
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-public: ${p}`);
  console.error(
    "check-public: not deploying; rebuild with apps/pen/scripts/build.sh <version> <relays>",
  );
  process.exit(1);
}
console.log("check-public: install.sh and its binaries are a release build");
