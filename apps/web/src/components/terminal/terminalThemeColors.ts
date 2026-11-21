// Read visibility when WASM finishes loading, not when setup starts.
export function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

export function readThemeColor(
  styles: CSSStyleDeclaration,
  variable: string,
  fallback: string,
): string {
  return normalizeComputedColor(styles.getPropertyValue(variable), fallback);
}
