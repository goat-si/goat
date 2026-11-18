/** Detach the clipped tail from its backing string while preserving UTF-16 code units. */
export const copyOutputTail = (output: string, length: number): string =>
  Buffer.from(output.slice(output.length - length), "utf16le").toString("utf16le");
