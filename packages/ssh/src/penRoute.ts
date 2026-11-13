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
const PEN_PIPE = new RegExp(
  `^(?:env PEN_HOME=${QUOTED} )?'(?:[^']|'\\\\'')*/pen' pipe %n 22$`,
  "u",
);

const penRoute = (settings: ReadonlyMap<string, string>) =>
  unset(settings.get("proxyjump")) && PEN_PIPE.test(settings.get("proxycommand") ?? "");

/** No jump chain or proxy command: a jump chain is what missed OpenCodex's link admission window. */
export const isPlainRoute = (settings: ReadonlyMap<string, string>) =>
  unset(settings.get("proxyjump")) && unset(settings.get("proxycommand"));

/**
 * The known_hosts file a Pen alias names, when ssh holds every connection to it strictly to that
 * file's key: StrictHostKeyChecking yes and no KnownHostsCommand.
 */
export const penKnownHostsFile = (settings: ReadonlyMap<string, string>) => {
  const file = settings.get("userknownhostsfile");
  const strict =
    settings.get("stricthostkeychecking") === "true" && unset(settings.get("knownhostscommand"));
  // ssh -G separates several files with spaces; a path with one is not a single file.
  return penRoute(settings) && strict && file !== undefined && /^\/\S+$/u.test(file)
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

export const penExactRoute = (settings: ReadonlyMap<string, string>) => {
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
  const route = penExactRoute(facts.settings);
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
  if (route.knownHostsFile !== facts.penKnownHosts) return "known-hosts-not-pen";
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
