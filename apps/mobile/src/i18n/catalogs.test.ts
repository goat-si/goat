// @effect-diagnostics nodeBuiltinImport:off - reads the committed catalogs and screen sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { hashSource } from "generaltranslation/id";
import { describe, expect, it } from "vite-plus/test";

// `gt generate` cannot rebuild these catalogs here (screens take useGT through I18nProvider), so
// this contract is what keeps them in step with the strings the app renders.
const mobileRoot = NodePath.resolve(__dirname, "../..");
const translationsDir = NodePath.join(mobileRoot, "src/i18n/translations");
const gtConfig: { readonly locales: ReadonlyArray<string> } = JSON.parse(
  NodeFS.readFileSync(NodePath.join(mobileRoot, "gt.config.json"), "utf8"),
);

function readCatalog(locale: string): Record<string, string> {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(translationsDir, `${locale}.json`), "utf8"));
}

function gtCalls() {
  const literals: Array<{ readonly file: string; readonly source: string }> = [];
  const nonLiterals: string[] = [];
  const files = NodeFS.readdirSync(NodePath.join(mobileRoot, "src"), { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file));
  for (const file of files) {
    const text = NodeFS.readFileSync(NodePath.join(mobileRoot, "src", file), "utf8");
    for (const call of text.matchAll(/(?<![.\w])gt\(\s*/g)) {
      const rest = text.slice((call.index ?? 0) + call[0].length);
      const literal = /^"((?:[^"\\\n]|\\.)*)"/.exec(rest);
      if (literal) literals.push({ file, source: JSON.parse(literal[0]) });
      else nonLiterals.push(`${file}: ${rest.slice(0, 40)}`);
    }
  }
  return { literals, nonLiterals };
}

describe("mobile translation catalogs", () => {
  it("has an English entry keyed by GT's hash for every gt() string the app renders", () => {
    const english = readCatalog("en");
    const { literals, nonLiterals } = gtCalls();

    expect(nonLiterals).toEqual([]);
    expect(literals.length).toBeGreaterThan(0);
    const mismatches = literals.flatMap(({ file, source }) => {
      const key = hashSource({ source, dataFormat: "ICU" });
      return english[key] === source ? [] : [`${file}: "${source}" needs ${key}`];
    });
    expect(mismatches).toEqual([]);
  });

  it("gives every shipped locale exactly the English key set", () => {
    const englishKeys = Object.keys(readCatalog("en")).sort();
    for (const locale of gtConfig.locales) {
      expect({ locale, keys: Object.keys(readCatalog(locale)).sort() }).toEqual({
        locale,
        keys: englishKeys,
      });
    }
  });
});
