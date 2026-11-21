import { normalizeModelMetricLabel } from "../observability/Attributes.ts";
import { providerTurnDuration, providerTurnsTotal, withMetrics } from "../observability/Metrics.ts";

export const providerTurnMetrics = (driver: string, operation: string, model?: string) =>
  withMetrics({
    counter: providerTurnsTotal,
    ...(operation === "send" ? { timer: providerTurnDuration } : {}),
    attributes: {
      provider: driver,
      operation,
      modelFamily: normalizeModelMetricLabel(model),
    },
  });
