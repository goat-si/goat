/*
Adapted from Synara (MIT): apps/web/src/lib/pdf/usePdfDocument.ts
MIT License

Copyright (c) 2026 T3 Tools Inc.
Copyright (c) 2026 Emanuele Di Pietro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { useEffect, useState } from "react";

import { loadPdfDocument, type PDFDocumentProxy } from "./pdfEngine";
import type { PdfSize } from "./pdfLayout";

export type PdfDocumentStatus = "loading" | "ready" | "error";

export interface PdfDocumentState {
  status: PdfDocumentStatus;
  document: PDFDocumentProxy | null;
  numPages: number;
  /** Size of page 1 at scale 1, used to lay out the scroll area before render. */
  firstPageSize: PdfSize | null;
  error: string | null;
}

const INITIAL_STATE: PdfDocumentState = {
  status: "loading",
  document: null,
  numPages: 0,
  firstPageSize: null,
  error: null,
};

interface PdfLoadSession {
  cancelled: boolean;
  loadedDocument: PDFDocumentProxy | null;
}

interface PdfLoadState {
  url: string;
  generation: number;
  state: PdfDocumentState;
}

export function usePdfDocument(url: string): PdfDocumentState {
  // A generation distinguishes separate visits to the same URL. Without it,
  // A -> B -> A can briefly revive A's old proxy after B's cleanup destroyed
  // it. Adjusting keyed state during render makes the new visit loading before
  // children can observe the stale resource.
  const [storedLoad, setStoredLoad] = useState<PdfLoadState>(() => ({
    url,
    generation: 0,
    state: INITIAL_STATE,
  }));
  const load =
    storedLoad.url === url
      ? storedLoad
      : { url, generation: storedLoad.generation + 1, state: INITIAL_STATE };
  if (load !== storedLoad) {
    setStoredLoad(load);
  }

  useEffect(() => {
    const session: PdfLoadSession = { cancelled: false, loadedDocument: null };
    const abortController = new AbortController();
    const generation = load.generation;

    void loadPdfIntoState(url, session, abortController, (next) => {
      setStoredLoad((current) =>
        current.url === url && current.generation === generation
          ? { ...current, state: next }
          : current,
      );
    });

    return () => {
      session.cancelled = true;
      abortController.abort();
      destroySessionDocument(session);
    };
  }, [load.generation, url]);

  return load.state;
}

function destroySessionDocument(session: PdfLoadSession): void {
  const document = session.loadedDocument;
  session.loadedDocument = null;
  if (document) {
    void document.loadingTask.destroy();
  }
}

// Module-level so the try/catch stays outside the compiled hook body — React
// Compiler does not yet support try/catch and would otherwise skip optimizing
// the whole hook.
async function loadPdfIntoState(
  url: string,
  session: PdfLoadSession,
  abortController: AbortController,
  setState: (state: PdfDocumentState) => void,
): Promise<void> {
  try {
    const response = await fetch(url, { signal: abortController.signal, cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load PDF (${response.status})`);
    }
    const bytes = await response.arrayBuffer();
    if (session.cancelled) {
      return;
    }
    const document = await loadPdfDocument(bytes, abortController.signal);
    session.loadedDocument = document;
    if (session.cancelled) {
      destroySessionDocument(session);
      return;
    }
    const firstPage = await document.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1 });
    if (session.cancelled) {
      destroySessionDocument(session);
      return;
    }
    setState({
      status: "ready",
      document,
      numPages: document.numPages,
      firstPageSize: { width: viewport.width, height: viewport.height },
      error: null,
    });
  } catch (error) {
    if (session.cancelled || abortController.signal.aborted) {
      return;
    }
    destroySessionDocument(session);
    setState({
      status: "error",
      document: null,
      numPages: 0,
      firstPageSize: null,
      error: error instanceof Error ? error.message : "Could not open this PDF.",
    });
  }
}
