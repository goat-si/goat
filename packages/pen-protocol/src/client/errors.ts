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
