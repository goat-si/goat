import {
  Language,
  StreamLanguage,
  defineLanguageFacet,
  languageDataProp,
  type StreamParser,
} from "@codemirror/language";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { go } from "@codemirror/legacy-modes/mode/go";
import { javascript, json, typescript } from "@codemirror/legacy-modes/mode/javascript";
import { python } from "@codemirror/legacy-modes/mode/python";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import type { Parser } from "@lezer/common";
import { GFM, parseCode, parser as markdownParser } from "@lezer/markdown";

// Small stream modes only: the full language-data set would multiply the editor asset.
const codeModes: ReadonlyArray<readonly [ReadonlyArray<string>, StreamParser<unknown>]> = [
  [["js", "javascript", "jsx", "mjs", "cjs"], javascript as StreamParser<unknown>],
  [["ts", "typescript", "tsx", "mts", "cts"], typescript as StreamParser<unknown>],
  [["json", "jsonc", "json5"], json as StreamParser<unknown>],
  [["py", "python"], python as StreamParser<unknown>],
  [["sh", "bash", "shell", "zsh", "console"], shell as StreamParser<unknown>],
  [["yaml", "yml"], yaml as StreamParser<unknown>],
  [["diff", "patch"], diff as StreamParser<unknown>],
  [["rs", "rust"], rust as StreamParser<unknown>],
  [["go", "golang"], go as StreamParser<unknown>],
  [["swift"], swift as StreamParser<unknown>],
  [["toml"], toml as StreamParser<unknown>],
];
const codeParsers = new Map<StreamParser<unknown>, Parser>();

function codeParser(info: string): Parser | null {
  const name =
    info
      .trim()
      .split(/[\s{,]/)[0]
      ?.toLowerCase() ?? "";
  const mode = codeModes.find(([names]) => names.includes(name))?.[1];
  if (!mode) return null;
  let parser = codeParsers.get(mode);
  if (!parser) {
    parser = StreamLanguage.define(mode).parser;
    codeParsers.set(mode, parser);
  }
  return parser;
}

const data = defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } });

export const noteMarkdown = new Language(
  data,
  markdownParser.configure([
    GFM,
    parseCode({ codeParser }),
    { props: [languageDataProp.add({ Document: data })] },
  ]),
  [],
  "markdown",
);
