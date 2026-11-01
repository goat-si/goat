import type { ActionChannel } from "./actionChannel.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

export const requireEvaluationChannel = (
  gate: { readonly channel?: ActionChannel | undefined } | undefined,
) => {
  if (!gate?.channel) throw new Error("An action channel is required for evaluation.");
  return gate.channel;
};

export const evaluationExpired = (
  channel: ActionChannel,
  reject: (cause: unknown) => void,
  timeoutMs: number,
) => {
  try {
    void channel.send("Runtime.terminateExecution").catch(reject);
  } catch (cause) {
    reject(cause);
    return;
  }
  reject(
    new ServerBrowserOperationError(
      "PreviewAutomationTimeoutError",
      `Evaluation did not finish within ${timeoutMs}ms and was stopped.`,
    ),
  );
};
