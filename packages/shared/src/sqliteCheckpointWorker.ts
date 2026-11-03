// @effect-diagnostics nodeBuiltinImport:off - The checkpoint worker is a raw Node worker owned by nodeSqliteClient.
import * as NodeWorkerThreads from "node:worker_threads";

import { guardErrors } from "./errorGuards.ts";
import { checkpointWorkerSource } from "./sqliteWorkerSources.ts";

export const CHECKPOINT_FRAMES = 1000;
const CHECKPOINT_IDLE_MS = 100;
export const CHECKPOINT_BACKPRESSURE_FRAMES = 10 * CHECKPOINT_FRAMES;

export const openCheckpointWorker = (
  filename: string,
  onError: (candidate: NodeWorkerThreads.Worker, cause: Error) => void,
) => {
  const candidate: NodeWorkerThreads.Worker = guardErrors(
    new NodeWorkerThreads.Worker(checkpointWorkerSource, {
      eval: true,
      workerData: {
        filename,
        frames: CHECKPOINT_FRAMES,
        backpressureFrames: CHECKPOINT_BACKPRESSURE_FRAMES,
        idleMs: CHECKPOINT_IDLE_MS,
      },
    }),
    (cause) => onError(candidate, cause),
  );
  return candidate;
};
