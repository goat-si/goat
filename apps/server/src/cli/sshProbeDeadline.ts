// @effect-diagnostics globalTimers:off -- Applies a deadline to the standalone SSH helper process.
const MAX_PROBE_DEADLINE_MS = 10_000;

export function sshProbeDeadline(milliseconds: number | undefined): () => void {
  if (milliseconds === undefined) return () => {};
  const timer = setTimeout(
    () => {
      process.stdout.write("timeout\n", () => process.exit(124));
    },
    Math.max(1, Math.min(milliseconds, MAX_PROBE_DEADLINE_MS)),
  );
  timer.unref();
  return () => clearTimeout(timer);
}
