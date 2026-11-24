const SHELL_SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/u;

export function shellDisplayToken(token: string): string {
  return SHELL_SAFE_TOKEN.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}
