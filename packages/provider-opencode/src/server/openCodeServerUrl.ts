export function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = line.match(/server listening on\s+(https?:\/\/[^\s]+)/i);
    if (match?.[1]) return match[1];
  }
  return null;
}
