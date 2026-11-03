/** For stdout/stderr whose reader may leave first: a closed pipe ends output, anything else still throws. */
export function ignoreClosedPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}
