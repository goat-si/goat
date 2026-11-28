import { expect, it } from "vite-plus/test";
import { classifyGuestUploads } from "./guestAttachments.ts";

it("cuts a long upload name between characters, never inside an emoji", () => {
  const name = `${"a".repeat(254)}😀.txt`;
  const classified = classifyGuestUploads([
    { name, contentType: "text/plain", sizeBytes: 1, header: new Uint8Array([0x61]) },
  ]);
  expect(classified.ok && classified.attachments[0]?.name).toBe("a".repeat(254));
});
