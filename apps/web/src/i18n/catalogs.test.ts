import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("keeps catalog keys and ICU argument names aligned across locales", () => {
  const directory = NodePath.join(__dirname, "translations");
  const read = (locale: string): Record<string, string> =>
    JSON.parse(NodeFS.readFileSync(NodePath.join(directory, `${locale}.json`), "utf8"));
  const english = read("en");
  const args = (value: string) =>
    [
      ...new Set([...value.matchAll(/\{\s*([a-zA-Z_]\w*)\s*(?:[,}])/gu)].map((match) => match[1])),
    ].sort();
  for (const locale of ["de", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh"]) {
    const translated = read(locale);
    expect(Object.keys(translated).sort(), locale).toEqual(Object.keys(english).sort());
    for (const [key, source] of Object.entries(english)) {
      expect(args(translated[key] ?? ""), `${locale}: ${key}`).toEqual(args(source));
    }
  }
});
