import JSZip from "jszip";
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

it.each(["Asia/Tokyo", "America/Chicago"])(
  "shows ZIP modified times as the archived wall-clock time in %s",
  async (timeZone) => {
    const zip = new JSZip();
    // JSZip writes the UTC parts of these dates as the entries' DOS wall-clock fields.
    zip.file("evening.txt", "a", { date: new Date(Date.UTC(2026, 10, 25, 20, 0)) });
    zip.file("night.txt", "b", { date: new Date(Date.UTC(2026, 10, 25, 1, 30)) });
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      const request = await startWorker();
      const result = await request({ type: "open", kind: "archive", name: "times.zip", bytes });
      if (result.type !== "archive") throw new Error("Expected archive");
      expect(
        result.entries.map(({ modified }) => {
          const date = new Date(modified!);
          return [date.toLocaleDateString("en-US"), date.getHours(), date.getMinutes()];
        }),
      ).toEqual([
        ["11/25/2026", 20, 0],
        ["11/25/2026", 1, 30],
      ]);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
      vi.unstubAllGlobals();
    }
  },
);
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
