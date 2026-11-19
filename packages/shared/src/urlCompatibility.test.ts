import { expect, it, vi } from "vite-plus/test";
import { promptLinkAppPath } from "./promptLinks.ts";
import { readPairingAppLink } from "./mobilePairingLink.ts";

it("reads app and pairing links without URL static helpers", () => {
  const NativeURL = URL;
  function UrlWithoutStatics(input: string | URL, base?: string | URL) {
    return new NativeURL(input, base);
  }
  vi.stubGlobal("URL", UrlWithoutStatics);
  try {
    expect(promptLinkAppPath("goat://new?prompt=hello")).toBe("/new?prompt=hello");
    expect(promptLinkAppPath("not a url")).toBeNull();
    expect(readPairingAppLink("goat://pair?pairingUrl=https%3A%2F%2Fexample.com")).toBe(
      "https://example.com",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
