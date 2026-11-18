// @effect-diagnostics globalTimers:off - The probe races a Playwright response outside Effect.
import type { CDPSession } from "playwright-core";
import { constVoid } from "effect/Function";

export const stopUnresponsiveScript = async (
  channel: Pick<CDPSession, "send">,
  canProbe: () => boolean,
  budgetMs = 1_000,
) => {
  if (budgetMs <= 0 || !canProbe()) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = channel.send("Runtime.evaluate", { expression: "0" }).then(
    () => true,
    () => true,
  );
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.min(budgetMs, 1_000));
  });
  const responsive = await Promise.race([answered, deadline]).finally(() => clearTimeout(timer));
  // Chromium can deliver termination while no navigation is pending, but need not answer it.
  if (!responsive && canProbe()) void channel.send("Runtime.terminateExecution").catch(constVoid);
  return !responsive;
};
