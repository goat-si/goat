import { expect, it } from "vite-plus/test";
import { fromSecret } from "./PayloadSigner.ts";

it("accepts legacy HMAC tokens and rejects changed payloads and signatures", () => {
  const signer = fromSecret(new TextEncoder().encode("legacy-secret"));
  const payload = "eyJ0aHJlYWQiOiJ0ZXN0In0";
  const legacySignature = "21gymYuyV02p8m6UawldeEGCgC4QMsFSVJZmNN4dCRU";
  expect(signer.sign(payload)).toBe(legacySignature);
  expect(signer.verify(payload, legacySignature)).toBe(true);
  expect(signer.verify(`${payload}x`, legacySignature)).toBe(false);
  expect(signer.verify(payload, `${legacySignature.slice(0, -1)}x`)).toBe(false);
});
