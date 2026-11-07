/** The launch watch's wake message ids, read without the launch watch itself. */
import { LAUNCH_WATCH_MESSAGE_PREFIX } from "../mcp/launchWatch.ts";

const decoded = (segment: string | undefined) => {
  try {
    return segment === undefined ? undefined : decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

/**
 * A launch-watch wake's launcher, host and launched thread from its message id, and for a run-end
 * wake the run and end it reports.
 */
export function parseLaunchWake(messageId: string) {
  if (!messageId.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX)) return undefined;
  // launcher:host:thread are URI-encoded, so none holds a colon; the event follows.
  const [launcher, host, thread, ...event] = messageId
    .slice(LAUNCH_WATCH_MESSAGE_PREFIX.length)
    .split(":");
  const text = event.join(":").replace(/:attempt-\d+$/, "");
  const where = { launcher: decoded(launcher), host: decoded(host), thread: decoded(thread) };
  if (!text.startsWith("run:")) return { ...where, runId: undefined, end: null };
  const body = text.slice("run:".length);
  // A later end of a run retried in place is run:<runId>:end:<end>; run ids never hold ":end:".
  const marker = body.indexOf(":end:");
  return {
    ...where,
    runId: marker < 0 ? body : body.slice(0, marker),
    end: marker < 0 ? null : body.slice(marker + ":end:".length),
  };
}
