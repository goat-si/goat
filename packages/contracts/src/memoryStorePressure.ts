/** Over MEMORY_STORE_TARGET_BYTES, log rows the published checkpoint covers are kept one day. */
export const MEMORY_LOG_PRESSURE_RETENTION_MS = 86400000;
/** Over the target, the hub republishes its checkpoint at most this often. */
export const MEMORY_STORE_PRESSURE_CHECKPOINT_INTERVAL_MS = 3600000;
