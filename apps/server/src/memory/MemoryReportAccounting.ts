/** Payload-free inventory. Reserve bounded mutable claim/code fields before delivery. */
export const reportMetadataBytes = (prefix = "") =>
  [
    "report_id",
    "space",
    "memory_id",
    "operation_id",
    "resolution_id",
    "attempt_id",
    "resolving_environment_id",
    "report_kind",
    "report_thread_json",
  ]
    .map((column) => `coalesce(length(CAST(${prefix}${column} AS BLOB)),0)`)
    .join("+") + `+coalesce(length(CAST(${prefix}resolving_environment_id AS BLOB)),0)+288`;
