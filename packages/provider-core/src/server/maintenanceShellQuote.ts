export function quoteShellWord(word: string, platform: NodeJS.Platform): string {
  const safeWord = platform === "win32" ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/;
  if (safeWord.test(word)) return word;
  return platform === "win32"
    ? `'${word.replace(/['\u2018\u2019]/g, "$&$&")}'`
    : `'${word.replaceAll("'", "'\\''")}'`;
}

export function quoteUpdateExecutable(executable: string, platform: NodeJS.Platform): string {
  const quoted = quoteShellWord(executable, platform);
  // Windows terminals default to PowerShell, where a quoted executable needs &.
  return platform === "win32" && quoted !== executable ? `& ${quoted}` : quoted;
}
