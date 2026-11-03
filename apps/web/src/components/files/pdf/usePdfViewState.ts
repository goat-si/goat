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

const positions = new Map<string, PdfViewState>();
const MAX_POSITIONS = 50;

export function usePdfViewState(documentId: string | undefined): PdfReadingPosition {
  const load = () =>
    (documentId === undefined ? undefined : positions.get(documentId)) ?? initialPdfView();
  const [saved, setSaved] = useState(() => ({ documentId, view: load() }));
  const current = saved.documentId === documentId ? saved : { documentId, view: load() };
  if (current !== saved) setSaved(current);
  return {
    view: current.view,
    onViewChange: (view) => {
      if (documentId !== undefined) {
        positions.delete(documentId);
        positions.set(documentId, view);
        const oldest = positions.keys().next();
        if (positions.size > MAX_POSITIONS && !oldest.done) positions.delete(oldest.value);
      }
      setSaved({ documentId, view });
    },
  };
}
