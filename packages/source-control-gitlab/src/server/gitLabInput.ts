export function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}
