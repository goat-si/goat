// @effect-diagnostics globalTimers:off - Playwright evaluation runs outside the Effect runtime.
import type { ActionChannel } from "./actionChannel.ts";
import type { PreviewAutomationEvaluateInput } from "@goat/contracts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

export const requireEvaluationChannel = (
  gate: { readonly channel?: ActionChannel | undefined } | undefined,
) => {
  if (!gate?.channel) throw new Error("An action channel is required for evaluation.");
  return gate.channel;
};

const evaluationExpired = (
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

export const evaluateWithTimeout = async (
  channel: ActionChannel,
  input: PreviewAutomationEvaluateInput,
  timeoutMs: number,
) => {
  const params = {
    expression: input.expression,
    awaitPromise: input.awaitPromise ?? true,
    returnByValue: true,
  };
  let timedOut = false;
  const evaluation = channel.send("Runtime.evaluate", params).then((classic) => {
    const failure = classic.exceptionDetails;
    const unparsed =
      failure?.exception?.className === "SyntaxError" &&
      failure.scriptId !== undefined &&
      failure.stackTrace === undefined;
    return unparsed && !timedOut && input.expression.includes("await")
      ? channel.send("Runtime.evaluate", { ...params, replMode: true })
      : classic;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      evaluationExpired(channel, reject, timeoutMs);
    }, timeoutMs);
  });
  return Promise.race([evaluation, expired]).finally(() => clearTimeout(timer));
};
