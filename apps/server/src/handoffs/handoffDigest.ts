import type { Handoff } from "@goat/contracts";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Handoff identifiers and arguments are hashed before storage.
import * as NodeCrypto from "node:crypto";
import { targetKey } from "./targetKey.ts";

export const storeName = (id: string) =>
  `handoff-${NodeCrypto.createHash("sha256").update(id).digest("hex")}`;

export const matchesArgs = (
  key: Uint8Array,
  handoff: Handoff,
  args: Readonly<Record<string, unknown>>,
) =>
  Effect.sync(() => {
    const expected = Buffer.from(
      NodeCrypto.createHmac("sha256", key).update(targetKey(args)).digest("hex"),
    );
    const actual = Buffer.from(handoff.dedupeKey);
    return expected.length === actual.length && NodeCrypto.timingSafeEqual(expected, actual);
  });
