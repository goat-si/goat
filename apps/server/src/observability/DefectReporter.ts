import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";

import { redactedDefects } from "./LogRedaction.ts";

/**
 * RpcServer reports every failed handler exit; typed failures are expected responses, so only
 * dies are logged. Effect's McpServer reports a dying tool handler here too. Each defect is logged
 * redacted, without its fields, whichever logger receives it, and the reported cause is read
 * without running any of its code (#1388).
 */
const reporter: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause, fiber }) => {
    for (const defect of redactedDefects(cause))
      Effect.runForkWith(fiber.context)(Effect.logError("Unhandled defect", defect));
  },
};

export const layer = ErrorReporter.layer([reporter]);
