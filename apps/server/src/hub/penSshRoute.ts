// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stable hash of SSH settings and public host keys.
import * as NodeCrypto from "node:crypto";

/** Settings `ssh -G` prints, keyed by lowercase option name, each value exactly as printed. */
export const sshSettings = (output: string): ReadonlyMap<string, string> =>
  new Map(
    output.split(/\r?\n/u).map((line) => {
      const [, key = "", value = ""] = /^\s*(\S+)(?: (.*))?$/u.exec(line) ?? [];
      return [key.toLowerCase(), value] as const;
    }),
  );

// OpenSSH's built-in GlobalKnownHostsFile, as ssh -G prints it.
const DEFAULT_GLOBAL_KNOWN_HOSTS = ["/etc/ssh/ssh_known_hosts", "/etc/ssh/ssh_known_hosts2"];

/**
 * The global known_hosts files ssh reads for an alias, when they are certain: ssh's default list
 * or none. ssh -G prints a custom setting unquoted, so its files cannot be named exactly.
 */
export const penGlobalFiles = (settings: ReadonlyMap<string, string>) => {
  const value = settings.get("globalknownhostsfile");
  if (value === undefined || value === "none") return [];
  return value === DEFAULT_GLOBAL_KNOWN_HOSTS.join(" ") ? DEFAULT_GLOBAL_KNOWN_HOSTS : undefined;
};

const unset = (value: string | undefined) =>
  value === undefined || value === "" || value === "none";

// The ProxyCommand `pen ssh-config` writes: the binary, optionally under its own PEN_HOME.
const QUOTED = "'(?:[^']|'\\\\'')*'";
const PEN_BINARY = `(?:env PEN_HOME=${QUOTED} )?'(?:[^']|'\\\\'')*/pen' pipe`;
const PEN_PIPE = new RegExp(`^${PEN_BINARY} %n 22$`, "u");
// An exact block's binary is whatever the confirmed Pen is, so its name is not checked here.
const ABSOLUTE = "'/(?:[^']|'\\\\'')*'";

/** A Pen member addressed by node id, with the Noise key GOAT recorded for it. */
export interface PenNode {
  readonly nodeId: string;
  readonly noisePub: string;
}

const NODE_ID = /^[a-z2-7]{26}$/u;
const NOISE_PUB = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The ProxyCommand of Pen's exact block for `node` ("<binary> pipe --node <id> --noise <key> 22")
 * with no jump chain; penExactCommands decides which binary and Pen home. An id another member
 * uses as its name gets only the name block's "pipe %n 22", which is refused here.
 */
export const penExactRoute = (settings: ReadonlyMap<string, string>, node: PenNode) => {
  if (!NODE_ID.test(node.nodeId) || !NOISE_PUB.test(node.noisePub)) return undefined;
  const command = settings.get("proxycommand") ?? "";
  const exact = new RegExp(
    `^(?:env PEN_HOME=${ABSOLUTE} )?${ABSOLUTE} pipe --node ${node.nodeId} --noise ${node.noisePub} 22$`,
    "u",
  );
  return unset(settings.get("proxyjump")) && exact.test(command) ? command : undefined;
};

const penRoute = (settings: ReadonlyMap<string, string>, node?: PenNode) =>
  node === undefined
    ? unset(settings.get("proxyjump")) && PEN_PIPE.test(settings.get("proxycommand") ?? "")
    : penExactRoute(settings, node) !== undefined;

/** The Pen a person confirmed for this machine: its executable and state folder (settings.pen). */
export interface PenInstall {
  readonly executablePath: string;
  readonly stateDir: string;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Words OpenCodex accepts in a link's explicit route (O6, src/link/explicit-route.ts): no quotes,
// shell syntax or % tokens, and the program path narrower than the words after it.
const ROUTE_PROGRAM = /^\/[A-Za-z0-9._+/-]*$/u;
const ROUTE_PATH = /^\/[A-Za-z0-9._/:@+,=-]*$/u;

/**
 * The ProxyCommand GOAT runs for a node: the confirmed pen with its state folder as --home, so an
 * inherited PEN_HOME or a later ssh_config edit cannot pick another Pen. Unquoted, as OpenCodex's
 * explicit link route requires; undefined for a path that would need quoting.
 */
export const penRunCommand = (node: PenNode, pen: PenInstall) => {
  if (!NODE_ID.test(node.nodeId) || !NOISE_PUB.test(node.noisePub)) return undefined;
  if (!ROUTE_PROGRAM.test(pen.executablePath) || !ROUTE_PATH.test(pen.stateDir)) return undefined;
  const command = `${pen.executablePath} pipe --node ${node.nodeId} --noise ${node.noisePub} --home ${pen.stateDir} 22`;
  return command.length <= 1024 ? command : undefined;
};

/** Whether a recorded command is penRunCommand's for `node`. */
export const isPenRunCommand = (command: string, node: PenNode) => {
  const words = /^(\S+) pipe --node \S+ --noise \S+ --home (\S+) 22$/u.exec(command);
  return (
    words !== null &&
    penRunCommand(node, { executablePath: words[1] ?? "", stateDir: words[2] ?? "" }) === command
  );
};

/** A user OpenCodex accepts in an explicit route, and ssh takes as one word. */
export const isRouteUser = (user: string) => /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/u.test(user);

/**
 * The ProxyCommands `pen ssh-config` writes for `node` when it is the confirmed Pen, as ssh -G
 * prints them: with PEN_HOME when it was set, and without it only for Pen's default ~/.pen.
 */
export const penExactCommands = (node: PenNode, pen: PenInstall, defaultStateDir: string) => {
  if (!NODE_ID.test(node.nodeId) || !NOISE_PUB.test(node.noisePub)) return [];
  const bare = `${shellQuote(pen.executablePath)} pipe --node ${node.nodeId} --noise ${node.noisePub} 22`;
  return [
    `env PEN_HOME=${shellQuote(pen.stateDir)} ${bare}`,
    ...(pen.stateDir === defaultStateDir ? [bare] : []),
  ].map((command) => command.replaceAll("%", "%%"));
};

/** No jump chain or proxy command: a jump chain is what missed OpenCodex's link admission window. */
export const isPlainRoute = (settings: ReadonlyMap<string, string>) =>
  unset(settings.get("proxyjump")) && unset(settings.get("proxycommand"));

/**
 * The known_hosts file a Pen alias names, when ssh holds every connection to it strictly to that
 * file's key: StrictHostKeyChecking yes and no KnownHostsCommand. With `node`, only Pen's exact block
 * for that node and Noise key counts; without it, only a name block.
 */
export const penKnownHostsFile = (settings: ReadonlyMap<string, string>, node?: PenNode) => {
  const file = settings.get("userknownhostsfile");
  const strict =
    settings.get("stricthostkeychecking") === "true" && unset(settings.get("knownhostscommand"));
  // ssh -G separates several files with spaces; a path with one is not a single file.
  return penRoute(settings, node) && strict && file !== undefined && /^\/\S+$/u.test(file)
    ? file
    : undefined;
};

/** The one fingerprint of `keyType` in `ssh-keygen -l -F` output; several name no key. */
export const fingerprintOfType = (keygen: string, keyType: string) => {
  const matches = keygen
    .split(/\r?\n/u)
    .map((line) => /^\S+ (\S+) (SHA256:[A-Za-z0-9+/]{43})$/u.exec(line.trim()))
    .filter((match) => match?.[1] === keyType);
  return matches.length === 1 ? matches[0]?.[2] : undefined;
};

/** The aliases of the Host blocks in Pen's own ssh config, without its pen-* fallback. */
export const penConfigHosts = (config: string) =>
  config
    .split(/\r?\n/u)
    .map((line) => /^Host\s+(\S+)\s*$/u.exec(line.trim())?.[1])
    .filter((alias): alias is string => alias !== undefined && !alias.includes("*"));

/**
 * An option of Pen's own Host block for `alias`, as written. Pen writes User only for a member
 * that published one.
 */
export const penHostOption = (config: string, alias: string, option: "User" | "ProxyCommand") => {
  let inBlock = false;
  for (const line of config.split(/\r?\n/u)) {
    // Any Host or Match line ends a block; only a Host line naming exactly the alias opens one.
    const section = /^(Host|Match)\s+(.*)$/iu.exec(line.trim());
    if (section !== null) inBlock = section[1] === "Host" && section[2]?.trim() === alias;
    else if (inBlock) {
      const value = new RegExp(`^${option}\\s+(\\S.*)$`, "u").exec(line.trim())?.[1];
      if (value !== undefined) return value;
    }
  }
  return undefined;
};

// The settings that decide which machine an alias reaches and which key ssh accepts for it.
const BOUND = [
  "hostname",
  "user",
  "port",
  "proxycommand",
  "proxyjump",
  "hostkeyalias",
  "stricthostkeychecking",
  "knownhostscommand",
  "globalknownhostsfile",
] as const;

/**
 * Identifies a Pen member's alias for consent: its effective settings and Pen's known_hosts lines
 * for it, which carry the member's node id and host keys. Another key, member or setting is another
 * host; only a clone holding the member's Pen identity and sshd keys yields the same value.
 * Undefined when Pen recorded no key.
 */
export const penRevision = (settings: ReadonlyMap<string, string>, keygen: string) => {
  const knownHostsFile = penKnownHostsFile(settings);
  const keys = keygen
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .toSorted();
  if (knownHostsFile === undefined || keys.length === 0) return undefined;
  const bound = BOUND.map((key) => `${key} ${settings.get(key) ?? ""}`);
  return `pen:${NodeCrypto.createHash("sha256")
    .update([...bound, `userknownhostsfile ${knownHostsFile}`, "", ...keys].join("\n"))
    .digest("hex")}`;
};
