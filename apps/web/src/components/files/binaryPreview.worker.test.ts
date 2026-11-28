import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";

import {
  compareArchiveRows,
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

it("sorts archive folders first, then numbered names in natural order", () => {
  const rows = ["page10.txt", "vol10", "page2.txt", "vol2", "page1.txt", "vol1"].map((path) => ({
    path,
    directory: path.startsWith("vol"),
  }));
  expect(rows.sort(compareArchiveRows).map(({ path }) => path)).toEqual([
    "vol1",
    "vol2",
    "vol10",
    "page1.txt",
    "page2.txt",
    "page10.txt",
  ]);
});

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

it("reads GNU base-256 TAR modification dates, including ones before 1970", async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const entries = [
    { path: "before-epoch.txt", mtime: new Uint8Array(12).fill(0xff) },
    { path: "far-future.txt", mtime: Uint8Array.of(0x80, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0) },
    { path: "out-of-range.txt", mtime: Uint8Array.of(0x80, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0) },
  ];
  const bytes = new Uint8Array(entries.length * 512 + 1024);
  entries.forEach((entry, index) => {
    const offset = index * 512;
    bytes.set(encode(entry.path), offset);
    bytes.set(encode("00000000000\0"), offset + 124);
    bytes.set(entry.mtime, offset + 136);
    bytes.fill(32, offset + 148, offset + 156);
    bytes.set(encode("0"), offset + 156);
    const sum = bytes.subarray(offset, offset + 512).reduce((acc, byte) => acc + byte, 0);
    bytes.set(encode(sum.toString(8).padStart(6, "0") + "\0 "), offset + 148);
  });

  try {
    const request = await startWorker();
    const result = await request({
      type: "open",
      kind: "archive",
      name: "gnu.tar",
      bytes: bytes.buffer,
    });
    if (result.type !== "archive") throw new Error(`Expected archive, got ${result.type}`);
    expect(result.entries.map(({ modified }) => modified)).toEqual([
      "1969-12-31T23:59:59.000Z",
      "2242-03-16T12:56:32.000Z",
      null,
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
