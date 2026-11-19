export function parseUrl(value: string, base?: string | URL): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}
