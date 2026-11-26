import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";

import {
  formatArchiveModifiedDate,
  type BinaryWorkerRequest,
  type BinaryWorkerResult,
} from "./binaryPreviewProtocol";

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

it.each([
  { timeZone: "Asia/Tokyo", tarEvening: "11/26/2026", tarNight: "11/25/2026" },
  { timeZone: "America/Chicago", tarEvening: "11/25/2026", tarNight: "11/24/2026" },
  { timeZone: "America/Nuuk", tarEvening: "11/25/2026", tarNight: "11/24/2026" },
])(
  "formats archived ZIP dates and local TAR instants in $timeZone",
  async ({ timeZone, tarEvening, tarNight }) => {
    const zip = new JSZip();
    // JSZip writes the UTC parts of these dates as the entries' DOS wall-clock fields.
    zip.file("evening.txt", "a", { date: new Date(Date.UTC(2026, 10, 25, 20, 0)) });
    zip.file("night.txt", "b", { date: new Date(Date.UTC(2026, 10, 25, 1, 30)) });
    zip.file("dst-midnight.txt", "c", { date: new Date(Date.UTC(2026, 2, 28, 23, 30)) });
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      const request = await startWorker();
      const result = await request({ type: "open", kind: "archive", name: "times.zip", bytes });
      if (result.type !== "archive") throw new Error("Expected archive");
      expect(result.entries.map(({ modified }) => modified)).toEqual([
        "2026-11-25T20:00:00.000",
        "2026-11-25T01:30:00.000",
        "2026-03-28T23:30:00.000",
      ]);
      expect(
        result.entries.map(({ modified }) => formatArchiveModifiedDate(modified, "en-US")),
      ).toEqual(["11/25/2026", "11/25/2026", "3/28/2026"]);
      expect([
        formatArchiveModifiedDate("2026-11-25T20:00:00.000Z", "en-US"),
        formatArchiveModifiedDate("2026-11-25T01:30:00.000Z", "en-US"),
        formatArchiveModifiedDate(null, "en-US"),
      ]).toEqual([tarEvening, tarNight, "-"]);
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
