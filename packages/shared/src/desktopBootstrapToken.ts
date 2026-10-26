import {
  GOAT_DESKTOP_BOOTSTRAP_HMAC_PREFIX,
  LEGACY_DESKTOP_BOOTSTRAP_HMAC_PREFIX,
} from "@goat/contracts/legacyT3Names";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

/** Accept previous/current windows for token lifetime and the next window for WSL clock lag. */
export const DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS = 12 * 60 * 60 * 1000;

function windowIndex(nowMs: number): number {
  return Math.floor(nowMs / DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS);
}

// New tokens use the GOAT prefix; validation also accepts tokens from older desktops.
function deriveToken(
  secret: string,
  window: number,
  prefix: string = GOAT_DESKTOP_BOOTSTRAP_HMAC_PREFIX,
): string {
  return NodeCrypto.createHmac("sha256", secret).update(`${prefix}${window}`).digest("hex");
}

export function currentDesktopBootstrapToken(secret: string, nowMs: number): string {
  return deriveToken(secret, windowIndex(nowMs));
}

export function isValidDesktopBootstrapToken(
  secret: string,
  token: string,
  nowMs: number,
): boolean {
  const presented = Buffer.from(token);
  const current = windowIndex(nowMs);
  return [LEGACY_DESKTOP_BOOTSTRAP_HMAC_PREFIX, GOAT_DESKTOP_BOOTSTRAP_HMAC_PREFIX].some((prefix) =>
    [current - 1, current, current + 1].some((window) => {
      const expected = Buffer.from(deriveToken(secret, window, prefix));
      return (
        expected.length === presented.length && NodeCrypto.timingSafeEqual(expected, presented)
      );
    }),
  );
}
