// @effect-diagnostics nodeBuiltinImport:off -- compared synchronously for each session and request.
import * as NodeCrypto from "node:crypto";
import { cursorBackendIdentity } from "./sdkBackend.ts";

/** Names the Cursor account an API key reaches at a backend, without holding the key. */
export const cursorAccountIdentity = (apiKey: string, backendUrl: string | undefined): string =>
  NodeCrypto.createHash("sha256")
    .update(`${cursorBackendIdentity(backendUrl)}\n${apiKey}`)
    .digest("hex");
