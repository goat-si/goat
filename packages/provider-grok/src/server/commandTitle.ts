/** Grok titles a Bash call with its command; cut it without splitting a surrogate pair. */
export function truncateCommandTitle(command: string): string {
  if (command.length <= 80) return command;
  const splitsPair =
    /[\uD800-\uDBFF]/.test(command.charAt(76)) && /[\uDC00-\uDFFF]/.test(command.charAt(77));
  return `${command.slice(0, splitsPair ? 76 : 77)}...`;
}
