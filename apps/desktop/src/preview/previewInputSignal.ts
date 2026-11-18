type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

export const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "pointer") {
    return (
      "x" in value &&
      typeof value.x === "number" &&
      "y" in value &&
      typeof value.y === "number" &&
      "button" in value &&
      typeof value.button === "number"
    );
  }
  return (
    value.kind === "key" &&
    "key" in value &&
    typeof value.key === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
};
