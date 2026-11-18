import type { PreviewAutomationSnapshotStage as Stage } from "@goat/contracts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

export class SnapshotTiming {
  private readonly running = new Map<Stage, number>();
  private readonly timedOut = new Set<Stage>();

  async track<A>(stage: Stage, work: () => Promise<A>): Promise<A> {
    this.running.set(stage, (this.running.get(stage) ?? 0) + 1);
    try {
      const result = await work();
      this.timedOut.delete(stage);
      return result;
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") this.timedOut.add(stage);
      throw cause;
    } finally {
      const count = (this.running.get(stage) ?? 1) - 1;
      if (count === 0) this.running.delete(stage);
      else this.running.set(stage, count);
    }
  }

  timeout(budgetMs: number) {
    const timeoutMs = Math.max(1, Math.ceil(budgetMs));
    return new ServerBrowserOperationError(
      "PreviewAutomationTimeoutError",
      `Snapshot capture timed out after ${timeoutMs}ms.`,
      { timeoutMs, pendingStages: [...new Set([...this.timedOut, ...this.running.keys()])] },
    );
  }

  unreadFrame(budgetMs: number) {
    this.timedOut.add("frames");
    return new ServerBrowserOperationError(
      "PreviewAutomationTimeoutError",
      "A frame did not answer in time to check it for hidden values. Try the snapshot again.",
      { timeoutMs: budgetMs, pendingStages: ["frames"] },
    );
  }
}
