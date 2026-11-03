import { ThreadId } from "@goat/contracts";

export const survivorRecords = (reviewCase: string | undefined) =>
  ["plain", "goal", "salted", "stop", "terminal"]
    .filter((kind) => !(["ordinary", "missing"].includes(reviewCase ?? "") && kind === "salted"))
    .map((kind) => ({
      version: 1 as const,
      instanceId: `codex-${kind}`,
      name: `codex-${kind}-abcdefabcdef`,
      socketPath: `/tmp/${kind}.sock`,
      pgid: kind === "plain" ? 1001 : 1002,
      bootId: "boot",
      state: "running" as const,
      createdAt: "2026-01-01T00:00:00Z",
      stderrMode: "discard" as const,
      ...(kind === "plain" && (reviewCase === "goal-release" || reviewCase === "goal-held")
        ? { goalBlocks: [{ threadId: ThreadId.make("old-goal"), nativeThreadId: "old-native" }] }
        : {}),
      ...(kind === "stop" && reviewCase === "stop-clear-crash"
        ? {
            stopObligations: [
              {
                threadId: ThreadId.make("stop"),
                nativeThreadId: "native-stop",
                nativeTurnId: "turn-native-stop",
              },
            ],
          }
        : {}),
    }));
