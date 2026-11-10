// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A standalone pre-deploy check.
// Refuses to publish public/ when install.sh points at loopback or plain-http relays (a local test
// build, such as installcheck.sh used to leave) or names a version with no dl/<version>/SHA256SUMS.
// Usage: node scripts/check-public.ts [public dir]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const dir = process.argv[2] ?? NodePath.join(import.meta.dirname, "..", "public");
const problems: string[] = [];
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
  else if (!NodeFS.existsSync(NodePath.join(dir, "dl", version, "SHA256SUMS"))) {
    problems.push(`install.sh installs ${version}, but dl/${version}/SHA256SUMS is missing`);
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
