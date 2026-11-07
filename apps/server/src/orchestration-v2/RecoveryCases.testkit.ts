export const cloudRecoveryCases = (["startup", "shutdown"] as const).flatMap((trigger) =>
  (["submitting", "running", "unknown", "failed", "succeeded", "cancelled"] as const).flatMap(
    (taskStatus) =>
      (taskStatus === "running" ? [false, true] : [false]).map((mixed) => ({
        trigger,
        taskStatus,
        mixed,
      })),
  ),
);
