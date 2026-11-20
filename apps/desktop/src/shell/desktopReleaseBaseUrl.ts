const MAX_RELEASE_BASE_URL_LENGTH = 2048;

export function validatedReleaseBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_RELEASE_BASE_URL_LENGTH) return undefined;
  try {
    const url = new URL(trimmed);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}
