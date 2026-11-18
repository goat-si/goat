/** Shell output a run holds while a dispatch is in flight; older output beyond it is dropped. */
const MAX_PENDING_SHELL_CHARS = 256 * 1024;
const MAX_PENDING_SHELL_ENTRIES = 64;

export interface ShellOutputDelta {
  readonly toolCallId: string;
  readonly event: {
    readonly case: "stdout" | "stderr";
    readonly value: { readonly data: unknown };
  };
}

/**
 * Keeps at most one shell output dispatch in flight per run. Output that arrives meanwhile merges
 * into one pending chunk per stream, so a loud command cannot queue a callback per chunk.
 */
export function makeShellOutputCoalescer(dispatch: (delta: ShellOutputDelta) => Promise<void>) {
  let pending: Array<ShellOutputDelta> = [];
  let pendingChars = 0;
  let flight: Promise<void> | null = null;
  const size = (delta: ShellOutputDelta) =>
    typeof delta.event.value.data === "string" ? delta.event.value.data.length : 0;
  const flush = (): void => {
    if (flight !== null || pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingChars = 0;
    let last = Promise.resolve();
    for (const delta of batch) last = dispatch(delta);
    flight = last.finally(() => {
      flight = null;
      flush();
    });
  };
  const push = (delta: ShellOutputDelta): void => {
    const previous = pending.at(-1);
    const data = delta.event.value.data;
    if (
      previous !== undefined &&
      typeof data === "string" &&
      typeof previous.event.value.data === "string" &&
      previous.toolCallId === delta.toolCallId &&
      previous.event.case === delta.event.case
    ) {
      pending[pending.length - 1] = {
        ...previous,
        event: { ...previous.event, value: { data: previous.event.value.data + data } },
      };
    } else {
      pending.push(delta);
    }
    pendingChars += size(delta);
    while (pendingChars > MAX_PENDING_SHELL_CHARS || pending.length > MAX_PENDING_SHELL_ENTRIES) {
      const oldest = pending[0];
      if (oldest === undefined) break;
      const excess = pendingChars - MAX_PENDING_SHELL_CHARS;
      if (pending.length <= MAX_PENDING_SHELL_ENTRIES && excess < size(oldest)) {
        const data = oldest.event.value.data as string;
        pending[0] = { ...oldest, event: { ...oldest.event, value: { data: data.slice(excess) } } };
        pendingChars -= excess;
      } else {
        pending.shift();
        pendingChars -= size(oldest);
      }
    }
    flush();
  };
  /** Resolves once every pushed delta has been dispatched and handled. */
  const idle = async (): Promise<void> => {
    while (flight !== null) await flight;
  };
  return { push, idle };
}
