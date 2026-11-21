import { expect, it } from "vite-plus/test";
import { normalizePairingCode } from "./pairingCode.ts";

it("normalizes recognized pairing codes while leaving other credentials exact", () => {
  expect(normalizePairingCode("abcd-efgh jkmn")).toBe("ABCDEFGHJKMN");
  expect(normalizePairingCode("opaque-token-1")).toBe("opaque-token-1");
  expect(normalizePairingCode("ABCD-EFGH-JKMI")).toBe("ABCD-EFGH-JKMI");
});
