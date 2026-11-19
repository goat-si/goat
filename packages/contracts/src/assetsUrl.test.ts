import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { AssetCreateUrlResult, AttachmentCreateUploadUrlResult } from "./assets.ts";

const asset = Schema.is(AssetCreateUrlResult);
const upload = Schema.is(AttachmentCreateUploadUrlResult);
it("rejects absolute and malformed signed asset and upload URLs", () => {
  for (const relativeUrl of [
    "https://evil.test/api/assets/token/file.png",
    "//evil.test/x",
    "/api/assets/../file",
    "/api/assets/token/%2e%2e",
    "/api/assets/token/file.png?x=1",
  ]) {
    expect(asset({ relativeUrl, expiresAt: 1 })).toBe(false);
  }
  for (const relativeUrl of [
    "https://evil.test/api/attachments/upload/token",
    "/api/attachments/upload/..",
    "/api/attachments/upload/token?x=1",
  ]) {
    expect(upload({ relativeUrl, attachmentId: "id", expiresAt: 1 })).toBe(false);
  }
});
