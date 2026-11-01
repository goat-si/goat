import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import fallbackUrl from "pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";

export type { PDFDocumentProxy, PDFPageProxy, PageViewport };

// These URL manifests live in the lazy PDF chunk. Vite emits the data files with
// the app's base path, including Electron's app scheme; no CDN or host origin.
const cmaps = import.meta.glob("../../../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
});
const fonts = import.meta.glob("../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
});
const wasm = import.meta.glob("../../../../node_modules/pdfjs-dist/wasm/*.{wasm,js}", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
});

async function readAsset(manifest: Record<string, unknown>, name: string) {
  const url = Object.entries(manifest).find(([path]) => path.endsWith(`/${name}`))?.[1];
  if (typeof url !== "string") throw new Error(`Missing PDF resource: ${name}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load PDF resource: ${name}`);
  return new Uint8Array(await response.arrayBuffer());
}

class BinaryDataFactory {
  fetch({ kind, filename }: { kind: string; filename: string }) {
    switch (kind) {
      case "cMapUrl":
        return readAsset(cmaps, filename);
      case "standardFontDataUrl":
        return readAsset(fonts, filename);
      case "wasmUrl":
        return readAsset(wasm, filename);
      default:
        throw new Error(`Unknown PDF resource kind: ${kind}`);
    }
  }
}

// Match the legacy worker to the legacy engine: Electron may lag the newest
// JavaScript built-ins used by the modern build.
export async function loadPdfEngine() {
  const engine = await import("pdfjs-dist/legacy/build/pdf.mjs");
  engine.GlobalWorkerOptions.workerSrc = workerUrl;
  return engine;
}

export async function loadPdfDocument(
  data: ArrayBuffer,
  signal: AbortSignal,
): Promise<PDFDocumentProxy> {
  const engine = await loadPdfEngine();
  signal.throwIfAborted();
  const task = engine.getDocument({
    data,
    useWorkerFetch: false,
    BinaryDataFactory,
    // PDF.js imports JavaScript decoders directly, bypassing BinaryDataFactory.
    wasmUrl: new URL(".", new URL(fallbackUrl, import.meta.url)).href,
  });
  let destruction: Promise<void> | undefined;
  const destroy = () => (destruction ??= task.destroy());
  const abort = () => {
    void destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await task.promise;
  } catch (cause) {
    await destroy();
    throw cause;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
