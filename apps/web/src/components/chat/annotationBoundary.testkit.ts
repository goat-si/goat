import type { PreviewAnnotationPayload } from "@goat/contracts";

export function boundaryAnnotation(length: number): PreviewAnnotationPayload {
  return {
    id: "annotation-boundary",
    pageUrl: "https://example.test",
    pageTitle: "Example",
    comment: "x".repeat(length),
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
