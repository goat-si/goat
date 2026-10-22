/**
 * One parser for what a person or agent types as an SSH destination: an ~/.ssh/config alias,
 * user@host, host:port or [v6]:port. Separate user and port fields win over inline ones.
 */
export interface SshDestination {
  readonly user: string | null;
  readonly hostname: string;
  readonly port: number | null;
}

export type SshDestinationResult =
  | { readonly ok: true; readonly destination: SshDestination }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): SshDestinationResult => ({ ok: false, message });

function parsePort(raw: string): number | null | undefined {
  if (raw.length === 0) return null;
  if (!/^\d{1,5}$/u.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

export function parseSshDestination(input: {
  readonly host: string;
  readonly user?: string | undefined;
  readonly port?: string | number | undefined;
}): SshDestinationResult {
  let hostname = input.host.trim();
  if (hostname.length === 0) return fail("Enter an SSH host or alias.");

  let user: string | null = null;
  const at = hostname.lastIndexOf("@");
  if (at === 0) return fail("Put the user name before @, as in jun@devbox.");
  if (at > 0) {
    user = hostname.slice(0, at).trim();
    hostname = hostname.slice(at + 1).trim();
  }

  let inlinePort: number | null = null;
  const bracketed = /^\[([^\]]+)\](?::([^:]*))?$/u.exec(hostname);
  if (bracketed) {
    hostname = bracketed[1]!.trim();
    if (bracketed[2] !== undefined) {
      const port = parsePort(bracketed[2]);
      if (port === undefined || port === null) return fail("SSH port must be between 1 and 65535.");
      inlinePort = port;
    }
  } else {
    const colon = hostname.split(":");
    if (colon.length === 2) {
      const port = parsePort(colon[1]!);
      if (port === undefined || port === null) return fail("SSH port must be between 1 and 65535.");
      hostname = colon[0]!.trim();
      inlinePort = port;
    }
  }

  // ssh treats a leading dash as an option, and whitespace would split the argument.
  if (hostname.length === 0) return fail("Enter an SSH host or alias.");
  if (hostname.startsWith("-") || /\s/u.test(hostname))
    return fail("SSH host names cannot start with - or contain spaces.");
  const fieldUser = input.user?.trim() ?? "";
  const effectiveUser = fieldUser.length > 0 ? fieldUser : user;
  if (
    effectiveUser !== null &&
    (effectiveUser.length === 0 || effectiveUser.startsWith("-") || /[\s@]/u.test(effectiveUser))
  )
    return fail("SSH user names cannot be empty, start with - or contain spaces or @.");

  const fieldPort =
    input.port === undefined
      ? null
      : typeof input.port === "number"
        ? String(input.port)
        : input.port.trim();
  const port = fieldPort === null ? null : parsePort(fieldPort);
  if (port === undefined) return fail("SSH port must be between 1 and 65535.");

  return { ok: true, destination: { user: effectiveUser, hostname, port: port ?? inlinePort } };
}
