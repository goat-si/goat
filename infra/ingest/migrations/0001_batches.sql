-- One row per accepted batch. The key leads with the UTC day the batch arrived, so
-- retention deletes a key range and needs no extra index (an index would add a row
-- write per insert). batch_id is the SHA-256 of the stored JSON, so an exact retry
-- on the same day is stored once.
CREATE TABLE batches (
  received_day TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  events TEXT NOT NULL,
  PRIMARY KEY (received_day, batch_id)
) WITHOUT ROWID;

-- Admitted batches and their storage cost per UTC day, for the daily budget.
CREATE TABLE daily_usage (
  day TEXT PRIMARY KEY,
  batches INTEGER NOT NULL,
  bytes INTEGER NOT NULL
) WITHOUT ROWID;
