import {
  GOAT_DESKTOP_BOOTSTRAP_HMAC_PREFIX,
  LEGACY_DESKTOP_BOOTSTRAP_HMAC_PREFIX,
} from "@goat/contracts/legacyT3Names";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

/**
 * The desktop app and the backends it launches share one secret, delivered
 * over the backend's bootstrap channel and never sent to the renderer. Both
 * sides derive the bootstrap token for a time window from it, so the token the
 * renderer holds rotates every window without the desktop having to reach a
 * running backend. A backend accepts the previous, current and next window's
 * token: the previous one so a token works for between one and two windows,
 * and the next one because a WSL backend's clock can trail the Windows clock
 * that derived the token, which would otherwise reject every fresh token for
 * a moment after each boundary. A token is still dead two windows after it
 * was issued.
 */
export const DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS = 12 * 60 * 60 * 1000;

function windowIndex(nowMs: number): number {
  return Math.floor(nowMs / DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS);
}

// Tokens are issued with the legacy prefix so older backends accept them; a later build that
// issues GOAT-prefixed tokens is accepted here already.
function deriveToken(
  secret: string,
  window: number,
  prefix: string = LEGACY_DESKTOP_BOOTSTRAP_HMAC_PREFIX,
): string {
  return NodeCrypto.createHmac("sha256", secret).update(`${prefix}${window}`).digest("hex");
}

/** The token the desktop hands out at `nowMs`. */
export function currentDesktopBootstrapToken(secret: string, nowMs: number): string {
  return deriveToken(secret, windowIndex(nowMs));
}

/** Whether `token` is the previous, current or next window's token at `nowMs`. */
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
