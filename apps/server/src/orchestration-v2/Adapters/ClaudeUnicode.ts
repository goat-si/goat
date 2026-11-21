export function claudeTruncate(text: string, maxLength: number): string {
  const truncated = text.slice(0, maxLength);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}
