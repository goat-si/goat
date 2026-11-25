import { expect, it, vi } from "vite-plus/test";

import { type BinaryWorkerRequest, type BinaryWorkerResult } from "./binaryPreviewProtocol";

async function startWorker() {
  const worker = new EventTarget();
  let receive = (_result: BinaryWorkerResult) => {};
  vi.stubGlobal(
    "self",
    Object.assign(worker, { postMessage: (result: BinaryWorkerResult) => receive(result) }),
  );
  vi.resetModules();
  await import("./binaryPreview.worker");
  return (input: BinaryWorkerRequest) =>
    new Promise<BinaryWorkerResult>((resolve) => {
      receive = resolve;
      worker.dispatchEvent(new MessageEvent("message", { data: input }));
    });
}

it("formats singular and plural byte labels for SQLite BLOB cells", async () => {
  const { default: initSqlJs } = await import("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE blobs(empty BLOB, one BLOB, four BLOB); INSERT INTO blobs VALUES (X'', X'FF', X'DEADBEEF');",
  );
  const bytes = db.export().slice().buffer;
  db.close();

  try {
    const request = await startWorker();
    await request({ type: "open", kind: "sqlite", name: "blobs.sqlite", bytes });
    expect(await request({ type: "rows", table: "blobs", page: 0 })).toEqual({
      type: "rows",
      table: "blobs",
      page: 0,
      columns: ["empty", "one", "four"],
      rows: [["[blob: 0 bytes]", "[blob: 1 byte]", "[blob: 4 bytes]"]],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
