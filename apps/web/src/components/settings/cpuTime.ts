export function formatCpuTime(seconds: number): string {
  const shortSeconds = seconds.toFixed(seconds >= 10 ? 1 : 2);
  if (Number(shortSeconds) < 60) return `${shortSeconds}s`;
  const minutes = seconds / 60;
  const shortMinutes = minutes.toFixed(minutes >= 10 ? 1 : 2);
  if (Number(shortMinutes) < 60) return `${shortMinutes}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

export function formatCpuTimeMs(valueMs: number): string {
  return formatCpuTime(valueMs / 1_000);
}
