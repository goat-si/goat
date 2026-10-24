/**
 * Cookies ignore ports, so every dev environment a browser pairs with on localhost adds its
 * session cookie (about 830 bytes, kept 30 days) to every request there. Past Node's default
 * 16 KB header limit, Vite and the server answer 431 Request Header Fields Too Large (#1185).
 * Browsers keep at most 180 cookies per host, about 150 KB at that size, so this limit is more
 * than a browser can send.
 */
export const DEV_MAX_HTTP_HEADER_SIZE = 256 * 1024;

/** NODE_OPTIONS for web dev processes, with any other options kept. */
export function withDevMaxHttpHeaderSize(nodeOptions: string | undefined): string {
  const kept = (nodeOptions ?? "")
    .split(/\s+/)
    .filter((option) => option.length > 0 && !option.startsWith("--max-http-header-size"));
  return [...kept, `--max-http-header-size=${DEV_MAX_HTTP_HEADER_SIZE}`].join(" ");
}
