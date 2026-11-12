/** The one error a Pen client module throws. `code` is stable; `closeCode` is the Pen or WebSocket close code that goes with it. */
export class PenError extends Error {
  readonly code: string;
  readonly closeCode: number | undefined;

  constructor(
    code: string,
    message?: string,
    options?: { readonly closeCode?: number | undefined; readonly cause?: unknown },
  ) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PenError";
    this.code = code;
    this.closeCode = options?.closeCode;
  }
}

/**
 * Hands an exception thrown by a caller's listener to the platform, as an event target does: through reportError
 * where the platform has it, else rethrown on its own microtask. The module's own work has already gone on.
 */
export function reportListenerError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}
