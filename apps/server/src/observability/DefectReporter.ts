import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";

import { redactCause } from "./LogRedaction.ts";

/**
 * RpcServer reports every failed handler exit; typed failures are expected responses, so only
 * dies are logged. Effect's McpServer reports a dying tool handler here too. The defect is logged
 * redacted, without its fields, whichever logger receives it (#1388).
 */
const reporter: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause, fiber }) => {
    for (const reason of cause.reasons) {
      if (reason._tag !== "Die" || ErrorReporter.isIgnored(reason.defect)) continue;
      Effect.runForkWith(fiber.context)(
        Effect.logError("Unhandled defect", redactCause(Cause.fromReasons([reason]))),
      );
    }
  },
};

export const layer = ErrorReporter.layer([reporter]);
