// Adapted from opencode (MIT). Copyright (c) 2025 opencode. See LICENSE.opencode.
import type { BundledFontProvider } from "@betteroffice/docx/layout";
import {
  loadBundledFontBytes,
  resolveBundledFamilyFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
  resolveScriptFallbackFace,
  type BundledFontFace,
} from "@betteroffice/fonts";
import { callDeadlineMs, waitOutsideDeadline } from "./worker-rpc";

// Every face loads from the app's own files, so no font request leaves the machine. The engines draw only with the
// faces they are handed, never the system's, so CJK text needs the `@betteroffice/fonts-cjk` faces to show at all.

/** The faces Word substitutes for a document's fonts: metric-compatible ones first, then Word's own fallbacks. */
export function wordFonts(): BundledFontProvider {
  const loader = (face: BundledFontFace | undefined) => (face ? () => loadFace(face) : undefined);

  return {
    resolve: (family, bold, italic) => loader(resolveMetricCompatFace(family, bold, italic)),
    resolveFamily: (family, bold, italic) => loader(resolveBundledFamilyFace(family, bold, italic)),
    resolveScriptFallback: (script, bold, italic) =>
      loader(resolveScriptFallbackFace(script, bold, italic)),
    resolveLastResort: (family, bold, italic) => () =>
      loadFace(resolveLastResortFace(family, bold, italic, "word")),
  };
}

/** The face PowerPoint draws a family with: its metric-compatible or bundled face, else PowerPoint's substitute. */
export function presentationFace(family: string, bold: boolean, italic: boolean): BundledFontFace {
  return (
    resolveMetricCompatFace(family, bold, italic) ??
    resolveBundledFamilyFace(family, bold, italic) ??
    resolveLastResortFace(family, bold, italic, "powerpoint")
  );
}

/** The face Excel's cells draw a family with when it is missing: its metric-compatible or bundled face, if any. */
export function sheetFace(family: string, bold: boolean, italic: boolean) {
  return (
    resolveMetricCompatFace(family, bold, italic) ??
    resolveBundledFamilyFace(family, bold, italic) ??
    resolveBundledFamilyFace(family, bold, false) ??
    resolveBundledFamilyFace(family, false, false)
  );
}

/**
 * A bundled face's bytes. The font package caches them per worker, so a face loads once per open file; the browser's
 * caches, which every worker shares, serve the files to the next. A download pauses every pending call's deadline and
 * has its own: CJK faces of 4 to 12 MB must not fail a preview on a slow link, and a stalled one must not hang it.
 */
export function loadFace(face: BundledFontFace) {
  const bound =
    callDeadlineMs + Math.ceil((face.byteLength / slowestFontLinkBytesPerSecond) * 1000);

  return waitOutsideDeadline(
    new Promise<ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "The fonts this document needs did not finish downloading. Check the connection, then open it again.",
            ),
          ),
        bound,
      );
      loadBundledFontBytes(face)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    }),
  );
}

/** 256 kbit/s. */
const slowestFontLinkBytesPerSecond = 32_000;
