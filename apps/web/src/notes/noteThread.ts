import type { NoteThreadLink } from "@goat/contracts";

export function noteThreadPresentation(
  thread: Pick<NoteThreadLink, "host" | "lastResult">,
  knownTitle: string | undefined,
) {
  return {
    label: `${knownTitle?.trim() || "Thread"} · ${thread.host ?? "This hub"}`,
    // A null result also comes back from a reachable host whose thread has not reported, so it
    // says nothing about the connection.
    status: thread.lastResult
      ? `${thread.lastResult.runStatus} · ${thread.lastResult.outcome ?? "No result reported"}`
      : "No result yet",
  };
}
