import { describe, expect, it } from "vite-plus/test";

import { resolveLocale } from "./locales.ts";

const SUPPORTED = ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh"];
const resolve = (language: string, systemLocales: ReadonlyArray<string>) =>
  resolveLocale(language, systemLocales, SUPPORTED, "en");

describe("resolveLocale", () => {
  it("uses a saved language this client ships over the host's languages", () => {
    expect(resolve("es", ["zh-CN"])).toBe("es");
    expect(resolve("en", ["es-ES"])).toBe("en");
  });

  it("follows the first host language this client ships for the system setting", () => {
    expect(resolve("system", ["it-IT", "es-MX", "zh-CN"])).toBe("es");
    expect(resolve("system", ["zh-CN"])).toBe("zh");
    expect(resolve("system", ["it-IT"])).toBe("en");
  });

  it("keeps Traditional Chinese hosts off the Simplified catalog", () => {
    expect(resolve("system", ["zh-TW", "es"])).toBe("es");
    expect(resolve("system", ["zh-Hant-HK"])).toBe("en");
  });

  it("treats a language saved by a newer client like the system setting", () => {
    expect(resolve("it", ["es-ES"])).toBe("es");
    expect(resolve("it", [])).toBe("en");
  });

  it("matches only the locales the calling client ships", () => {
    expect(resolveLocale("ko", ["ko-KR"], ["en", "es"], "en")).toBe("en");
    expect(resolveLocale("system", ["pt-BR", "es"], ["en", "es"], "en")).toBe("es");
  });
});
