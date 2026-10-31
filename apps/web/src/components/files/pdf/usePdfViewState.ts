import { useState } from "react";
import type { PdfZoom } from "./pdfLayout";

export interface PdfViewState {
  anchor: { page: number; fraction: number };
  zoom: PdfZoom;
  left: number;
}

export interface PdfReadingPosition {
  view: PdfViewState;
  onViewChange: (view: PdfViewState) => void;
}

export const initialPdfView = (): PdfViewState => ({
  anchor: { page: 0, fraction: 0 },
  zoom: "fit-width",
  left: 0,
});

export function usePdfViewState(documentId: string): PdfReadingPosition {
  const [saved, setSaved] = useState(() => ({ documentId, view: initialPdfView() }));
  const current = saved.documentId === documentId ? saved : { documentId, view: initialPdfView() };
  if (current !== saved) setSaved(current);
  return {
    view: current.view,
    onViewChange: (view) => setSaved({ documentId, view }),
  };
}
