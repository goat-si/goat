import { describe, expect, it } from "vite-plus/test";

import { resolveLocale } from "./locales";

describe("resolveLocale", () => {
  it("uses a saved language this client ships over the host's languages", () => {
    expect(resolveLocale("es", ["zh-CN"])).toBe("es");
    expect(resolveLocale("en", ["es-ES"])).toBe("en");
  });

  it("follows the first host language this client ships for the system setting", () => {
    expect(resolveLocale("system", ["it-IT", "es-MX", "zh-CN"])).toBe("es");
    expect(resolveLocale("system", ["zh-CN"])).toBe("zh");
    expect(resolveLocale("system", ["it-IT"])).toBe("en");
  });

  it("keeps Traditional Chinese hosts off the Simplified catalog", () => {
    expect(resolveLocale("system", ["zh-TW", "es"])).toBe("es");
    expect(resolveLocale("system", ["zh-Hant-HK"])).toBe("en");
  });

  it("treats a language saved by a newer client like the system setting", () => {
    expect(resolveLocale("it", ["es-ES"])).toBe("es");
    expect(resolveLocale("it", [])).toBe("en");
  });
});
