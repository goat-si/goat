import { expect, it } from "vite-plus/test";
import { piExtensionDisplayName } from "./extensionDisplayName.ts";

it("names folder extensions after their directory", () => {
  expect(piExtensionDisplayName("/ext/a/index.ts")).toBe("a");
  expect(piExtensionDisplayName("/ext/a.ts")).toBe("a");
});
