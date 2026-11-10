// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stable hash of SSH settings and public host keys.
import * as NodeCrypto from "node:crypto";

/** Settings `ssh -G` prints, keyed by lowercase option name. */
export const sshSettings = (output: string): ReadonlyMap<string, string> =>
  new Map(
    output.split(/\r?\n/u).map((line) => {
      const [key = "", ...value] = line.trim().split(/\s+/u);
      return [key.toLowerCase(), value.join(" ")] as const;
    }),
  );

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
 * Identifies a Pen member's alias for consent: its effective settings and the known_hosts lines Pen
 * recorded for it, whose host names carry the member's node id. A changed key, a member that later
 * takes the same name, or changed settings is another host. Undefined when Pen recorded no key.
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
