// Minimal MSP handshake fixture; mutable state allows tests to inspect calls without a real CLI.
export const calls: unknown[] = [];
export let closes = 0;
export function reset() { calls.length = 0; closes = 0; }
export function spawnMspConnection(options: unknown) {
  calls.push(options);
  return {
    initialize(params: unknown) {
      calls.push(params);
      if (process.env.GOAT2_MUSE_FAKE_FAIL === "1") return Promise.reject(new Error("fixture failure"));
      return Promise.resolve({ initializeResult: { schema: { version: 1 } } });
    },
    async close() { closes++; },
  };
}
