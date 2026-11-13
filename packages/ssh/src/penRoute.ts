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
export const penGlobalFiles = (
  settings: ReadonlyMap<string, string>,
  input?: { platform?: NodeJS.Platform; programData?: string | undefined },
) => {
  const value = settings.get("globalknownhostsfile");
  if (value === undefined || value === "none") return [];
  if (input?.platform === "win32") {
    const root = input.programData;
    if (!root || /\s/u.test(root) || !windowsAbsolute(root)) return undefined;
    const files = windowsGlobalFiles(root);
    const placeholder = windowsGlobalFiles("__PROGRAMDATA__");
    return value === files.join(" ") || value === placeholder.join(" ") ? files : undefined;
  }
  return value === DEFAULT_GLOBAL_KNOWN_HOSTS.join(" ") ? DEFAULT_GLOBAL_KNOWN_HOSTS : undefined;
};

const windowsGlobalFiles = (root: string) => [
  `${root}\\ssh/ssh_known_hosts`,
  `${root}\\ssh/ssh_known_hosts2`,
];

const windowsAbsolute = (value: string) =>
  /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/u.test(value);

const windowsQuoted = (text: string, start: number): { value: string; end: number } | undefined => {
  if (text[start] !== '"') return undefined;
  let value = "";
  let i = start + 1;
  while (i < text.length) {
    let slashes = 0;
    while (text[i] === "\\") {
      slashes++;
      i++;
    }
    if (text[i] === '"') {
      value += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2 === 0) return { value, end: i + 1 };
      value += '"';
      i++;
    } else {
      value += "\\".repeat(slashes);
      if (i >= text.length) return undefined;
      value += text[i];
      i++;
    }
  }
  return undefined;
};

const windowsExactPipe = (command: string) => {
  const program = windowsQuoted(command, 0);
  // CreateProcess reads the program name without escapes, so a quote in it is not pen's form.
  if (
    !program ||
    !windowsAbsolute(program.value) ||
    program.value.includes('"') ||
    !/[\\/]pen\.exe$/iu.test(program.value)
  )
    return undefined;
  let rest = command.slice(program.end);
  if (!rest.startsWith(" pipe")) return undefined;
  rest = rest.slice(5);
  if (rest.startsWith(" --home ")) {
    const home = windowsQuoted(rest, 8);
    if (!home || !windowsAbsolute(home.value)) return undefined;
    rest = rest.slice(home.end);
  }
  const match = /^ --node ([a-z2-7]{26}) --noise ([A-Za-z0-9_-]{43}) 22$/u.exec(rest);
  return match ? { nodeId: match[1], noisePub: match[2] } : undefined;
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

export const PEN_EXACT_ALIAS = /^pen-([a-z2-7]{26})$/u;
const PEN_EXACT_PIPE = new RegExp(
  `^(?:env PEN_HOME=${QUOTED} )?'(?:[^']|'\\\\'')*/pen' pipe --node ([a-z2-7]{26}) --noise ([A-Za-z0-9_-]{43}) 22$`,
  "u",
);

export const penExactAliasRoute = (
  settings: ReadonlyMap<string, string>,
  platform?: NodeJS.Platform,
) => {
  if (platform === "win32") {
    const match = windowsExactPipe(settings.get("proxycommand") ?? "");
    const file = settings.get("userknownhostsfile");
    return match &&
      unset(settings.get("proxyjump")) &&
      ["true", "yes"].includes(settings.get("stricthostkeychecking") ?? "") &&
      unset(settings.get("knownhostscommand")) &&
      ["false", "no"].includes(settings.get("controlmaster") ?? "") &&
      unset(settings.get("controlpath")) &&
      file !== undefined
      ? { ...match, knownHostsFile: file }
      : undefined;
  }
  const match = PEN_EXACT_PIPE.exec(settings.get("proxycommand") ?? "");
  const file = settings.get("userknownhostsfile");
  return match !== null &&
    unset(settings.get("proxyjump")) &&
    settings.get("stricthostkeychecking") === "true" &&
    unset(settings.get("knownhostscommand")) &&
    settings.get("controlmaster") === "false" &&
    settings.get("controlpath") === "none" &&
    file !== undefined &&
    /^\/\S+$/u.test(file)
    ? { nodeId: match[1], noisePub: match[2], knownHostsFile: file }
    : undefined;
};

export type PenRouteRefusal =
  | "not-in-pen-config"
  | "not-pen-route"
  | "node-mismatch"
  | "known-hosts-not-pen"
  | "global-known-hosts"
  | "no-recorded-key"
  | "marker-lines";
export interface PenAliasFacts {
  readonly alias: string;
  readonly platform?: NodeJS.Platform;
  readonly configHosts: ReadonlyArray<string>;
  readonly settings: ReadonlyMap<string, string>;
  readonly penKnownHosts: string;
  readonly globalKey: boolean;
  readonly recorded: string;
}

export const penExactAliasDecision = (
  facts: PenAliasFacts,
):
  | { readonly nodeId: string; readonly noisePub: string; readonly revision: string }
  | PenRouteRefusal => {
  if (!facts.configHosts.includes(facts.alias)) return "not-in-pen-config";
  const alias = PEN_EXACT_ALIAS.exec(facts.alias);
  const route = penExactAliasRoute(facts.settings, facts.platform);
  if (
    !alias ||
    !route ||
    !route.nodeId ||
    !route.noisePub ||
    facts.settings.get("hostname") !== facts.alias ||
    facts.settings.get("port") !== "22" ||
    !unset(facts.settings.get("hostkeyalias"))
  )
    return "not-pen-route";
  if (route.nodeId !== alias[1]) return "node-mismatch";
  if (facts.platform === "win32") {
    const file = route.knownHostsFile;
    if (
      /\s/u.test(file) ||
      !windowsAbsolute(file) ||
      file.replaceAll("\\", "/") !== facts.penKnownHosts.replaceAll("\\", "/")
    )
      return "known-hosts-not-pen";
  } else if (route.knownHostsFile !== facts.penKnownHosts) return "known-hosts-not-pen";
  if (facts.globalKey) return "global-known-hosts";
  const keys = facts.recorded
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .toSorted();
  if (keys.length === 0) return "no-recorded-key";
  if (keys.some((line) => line.startsWith("@"))) return "marker-lines";
  const bound = [...BOUND, "controlmaster", "controlpath"].map(
    (key) => `${key} ${facts.settings.get(key) ?? ""}`,
  );
  const revision = `pen:${NodeCrypto.createHash("sha256")
    .update([...bound, `userknownhostsfile ${route.knownHostsFile}`, "", ...keys].join("\n"))
    .digest("hex")}`;
  return { nodeId: route.nodeId, noisePub: route.noisePub, revision };
};
