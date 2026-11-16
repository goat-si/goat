/** Commands each ACP session advertised, oldest first; capped so per-session history stays bounded. */
export type BySession = ReadonlyMap<string, ReadonlySet<string>>;

// A parent and its child sessions announce separately, and a resumed session need not announce again.
export const MAX_SESSIONS = 8;

export const empty: BySession = new Map();

export const remember = (
  current: BySession,
  sessionId: string,
  commands: ReadonlyArray<{ readonly name: string }>,
): BySession => {
  const next = new Map(current);
  next.delete(sessionId);
  next.set(sessionId, new Set(commands.map((command) => command.name.trim().toLowerCase())));
  for (const oldest of next.keys()) {
    if (next.size <= MAX_SESSIONS) break;
    next.delete(oldest);
  }
  return next;
};

export const advertises = (advertised: BySession, sessionId: string, name: string): boolean =>
  advertised.get(sessionId)?.has(name) === true;
