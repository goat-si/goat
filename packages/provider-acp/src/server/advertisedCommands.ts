/** The session that advertised commands last; one record, so no per-session history accumulates. */
export interface Latest {
  readonly sessionId: string;
  readonly names: ReadonlySet<string>;
}

export const remember = (
  sessionId: string,
  commands: ReadonlyArray<{ readonly name: string }>,
): Latest => ({
  sessionId,
  names: new Set(commands.map((command) => command.name.trim().toLowerCase())),
});

export const advertises = (advertised: Latest | null, sessionId: string, name: string): boolean =>
  advertised?.sessionId === sessionId && advertised.names.has(name);
