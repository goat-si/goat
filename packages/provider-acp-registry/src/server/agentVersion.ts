export function boundedAgentVersion(value: string | undefined): string | undefined {
  if (value === undefined || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, 64);
}
