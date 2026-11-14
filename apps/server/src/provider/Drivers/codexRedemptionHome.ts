/** The home Codex uses: CODEX_HOME exactly as written, else .codex under HOME (USERPROFILE on Windows). */
export const codexHomeFor = (
  env: NodeJS.ProcessEnv,
  host: {
    readonly platform: NodeJS.Platform;
    readonly homeDirectory: string;
    readonly sep: string;
  },
): string =>
  env.CODEX_HOME ||
  `${(host.platform === "win32" ? env.USERPROFILE : env.HOME) || host.homeDirectory}${host.sep}.codex`;
