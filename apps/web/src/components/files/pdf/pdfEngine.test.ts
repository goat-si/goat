import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { loadPdfDocument } from "./pdfEngine";

const { getDocument, PDFWorker } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  PDFWorker: vi.fn(
    class PDFWorker {
      readonly destroyed = false;
    },
  ),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument,
  PDFWorker,
  GlobalWorkerOptions: {},
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  getDocument.mockReset();
});

describe("PDF loading task ownership", () => {
  it("reuses a worker while each document keeps its own loading task", async () => {
    const destroyA = vi.fn(async () => {});
    const destroyB = vi.fn(async () => {});
    getDocument.mockReturnValueOnce({ promise: Promise.resolve({ id: "a" }), destroy: destroyA });
    getDocument.mockReturnValueOnce({ promise: Promise.resolve({ id: "b" }), destroy: destroyB });
    await loadPdfDocument(new ArrayBuffer(1), new AbortController().signal);
    await loadPdfDocument(new ArrayBuffer(1), new AbortController().signal);
    expect(getDocument.mock.calls[0]?.[0].worker).toBeDefined();
    expect(getDocument.mock.calls[0]?.[0].worker).toBe(getDocument.mock.calls[1]?.[0].worker);
    expect(destroyA).not.toHaveBeenCalled();
    expect(destroyB).not.toHaveBeenCalled();
  });
  it("destroys a worker-backed loading task when parsing fails", async () => {
    const destroy = vi.fn(async () => {});
    getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error("Invalid PDF")),
      destroy,
    }));
    await expect(loadPdfDocument(new ArrayBuffer(1), new AbortController().signal)).rejects.toThrow(
      "Invalid PDF",
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("cancels a pending load once and never returns an obsolete document", async () => {
    const pending = deferred<never>();
    const started = deferred<void>();
    const destroy = vi.fn(async () => {
      pending.reject(new Error("Load cancelled"));
    });
    getDocument.mockImplementation(() => {
      started.resolve();
      return { promise: pending.promise, destroy };
    });
    const controller = new AbortController();
    const loading = loadPdfDocument(new ArrayBuffer(1), controller.signal);
    const result = expect(loading).rejects.toThrow("Load cancelled");
    await started.promise;
    controller.abort();
    await result;
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("does not start parsing an already aborted file visit", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadPdfDocument(new ArrayBuffer(1), controller.signal)).rejects.toThrow();
    expect(getDocument).not.toHaveBeenCalled();
  });
});
