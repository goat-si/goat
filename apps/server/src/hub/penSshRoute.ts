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

/**
 * A jump chain is what missed OpenCodex's 15-second link admission window. Pen's pipe is one relay
 * hop that connects in a few seconds, so an alias `pen ssh-config` wrote counts as direct.
 */
export const isDirectRoute = (settings: ReadonlyMap<string, string>) =>
  penRoute(settings) || (unset(settings.get("proxyjump")) && unset(settings.get("proxycommand")));

/**
 * The known_hosts file Pen keeps for a Pen alias. ssh already holds every connection to that
 * alias to it (StrictHostKeyChecking yes), so its key is the alias's pin.
 */
export const penKnownHostsFile = (settings: ReadonlyMap<string, string>) => {
  const file = settings.get("userknownhostsfile");
  // ssh -G separates several files with spaces; a path with one is not a single file.
  return penRoute(settings) && file !== undefined && /^\/\S+$/u.test(file) ? file : undefined;
};

/** The one fingerprint of `keyType` in `ssh-keygen -l -F` output; several name no key. */
export const fingerprintOfType = (keygen: string, keyType: string) => {
  const matches = keygen
    .split(/\r?\n/u)
    .map((line) => /^\S+ (\S+) (SHA256:[A-Za-z0-9+/]{43})$/u.exec(line.trim()))
    .filter((match) => match?.[1] === keyType);
  return matches.length === 1 ? matches[0]?.[2] : undefined;
};
