const C_QUOTE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** Reads git's C-style quoting (`"a\tb\303\251"`), whose octal escapes are UTF-8 bytes. */
export function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < quoted.length - 1; index += 1) {
    const char = String.fromCodePoint(quoted.codePointAt(index) ?? 0);
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      index += char.length - 1;
      continue;
    }
    const next = quoted[index + 1] ?? "";
    const octal = /^[0-7]{3}/u.exec(quoted.slice(index + 1, index + 4))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
    } else {
      bytes.push(C_QUOTE_ESCAPES[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
