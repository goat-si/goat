import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each(["https://example.com/legal", "javascript:alert(1)"])(
    "rejects a URL outside the legal-document allowlist: %s",
    (url) => {
      expect(isLegalDocumentUrl(url)).toBe(false);
    },
  );
});
describe("default legal pages", () => {
  it("accepts GOAT's own legal pages and refuses upstream T3 Code's", () => {
    expect(isLegalDocumentUrl("https://goat-si.github.io/goat/privacy-policy")).toBe(true);
    expect(isLegalDocumentUrl("https://goat-si.github.io/goat/terms-of-service/")).toBe(true);
    expect(isLegalDocumentUrl("https://t3.codes/privacy-policy")).toBe(false);
  });
});
