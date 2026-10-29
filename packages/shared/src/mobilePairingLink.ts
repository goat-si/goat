import { PRODUCTION_SCHEME } from "./mobileAppIdentity.ts";

/** Query parameter of a `goat://pair` link that carries the server's pairing URL. */
export const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

/** Every GOAT channel scheme, plus the legacy ones that older servers printed. */
const PAIRING_APP_LINK_PROTOCOL = /^(?:goat|t3code)(?:-[a-z]+)?:$/; // goat-rename: legacy

/**
 * Wraps a server pairing URL in the app's `goat://pair` link for phone QR codes. Every build
 * gets the production scheme: the in-app scanner unwraps any GOAT or legacy t3code scheme, and
 * the wrapped URL keeps its token in the fragment.
 */
export function buildMobilePairingLink(pairingUrl: string): string {
  const url = new URL(`${PRODUCTION_SCHEME}://pair`);
  url.searchParams.set(MOBILE_PAIRING_URL_PARAM, pairingUrl);
  return url.toString();
}

/** Reads the pairing URL out of a `goat://pair` link, or null for any other link. */
export function readPairingAppLink(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (!PAIRING_APP_LINK_PROTOCOL.test(url.protocol) || url.host !== "pair") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  return url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() || null;
}
