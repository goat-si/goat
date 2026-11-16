// Worker side, included in each worker source: a large result leaves in batches with at most one
// unacknowledged, so neither thread holds the whole result in a single structured clone.
export const rowBatchesSource = `
const collectRows = (iterator, received, sendBatch) => {
  let rows = [];
  let bytes = 0;
  let pendingBatch = false;
  for (const row of iterator) {
    let rowBytes = 0;
    for (const key in row) {
      const value = row[key];
      rowBytes += typeof value === "string" ? value.length * 2
        : ArrayBuffer.isView(value) ? value.byteLength : 8;
    }
    if (rows.length > 0 && (rows.length >= 16384 || bytes + rowBytes > 8 * 1024 * 1024)) {
      // Build the next batch during receipt, but allow only one unacknowledged message.
      if (pendingBatch) Atomics.wait(received, 0, 0);
      Atomics.store(received, 0, 0);
      sendBatch(rows);
      rows = [];
      bytes = 0;
      pendingBatch = true;
    }
    rows.push(row);
    bytes += rowBytes;
  }
  if (pendingBatch) Atomics.wait(received, 0, 0);
  return rows;
};
`;

export interface Batches {
  readonly received: Int32Array;
  readonly rows: Array<unknown>;
}

export const make = (): Batches => ({
  received: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
  rows: [],
});

export const acknowledge = (batches: Batches, rows: ReadonlyArray<unknown>) => {
  for (const row of rows) batches.rows.push(row);
  Atomics.store(batches.received, 0, 1);
  Atomics.notify(batches.received, 0);
};

// A final reply after earlier batches carries only the tail of the result.
export const finish = <Reply extends object>(batches: Batches, reply: Reply): Reply => {
  if (batches.rows.length === 0 || !("rows" in reply) || !Array.isArray(reply.rows)) return reply;
  for (const row of reply.rows) batches.rows.push(row);
  return { ...reply, rows: batches.rows };
};
