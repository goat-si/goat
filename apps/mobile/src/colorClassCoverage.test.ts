// @effect-diagnostics nodeBuiltinImport:off - reads real source and theme files on disk.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const mobileRoot = NodePath.resolve(__dirname, "..");
const requireFromMobile = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
const babel: {
  parseSync: (code: string, options: Record<string, unknown>) => unknown;
  traverse: (ast: unknown, visitors: Record<string, (path: BabelPath) => void>) => void;
} = requireFromMobile("@babel/core");
const tailwind: {
  __unstable__loadDesignSystem: (
    css: string,
    options: {
      base: string;
      loadStylesheet: (
        id: string,
        base: string,
      ) => Promise<{ path: string; base: string; content: string }>;
    },
  ) => Promise<{ candidatesToCss: (classes: string[]) => Array<string | null> }>;
} = requireFromMobile("tailwindcss");

interface BabelPath {
  readonly node: {
    readonly value?: string;
    readonly quasis?: ReadonlyArray<{ readonly value: { readonly cooked?: string | null } }>;
  };
  readonly parent: { readonly type: string; readonly name?: { readonly name?: unknown } };
}

const COLOR_UTILITY =
  /^(?:[\w-]+:)*!?(?:bg|text|border(?:-[trblxyse])?|fill|stroke|ring|outline|divide|placeholder|decoration|caret|accent|from|via|to|shadow)-[a-z]/;
// CSS declarations inside template documents look like utilities but are not classes.
const CLASS_TOKEN = /^[\w!:\-[\]/.%#()]*[\w\])%]$/;

// Uniwind registers each theme as a variant and exposes the theme's --color-* variables as
// utilities during its Metro build; mirror both so Tailwind resolves classes as the app does.
async function loadMobileDesignSystem() {
  const themeCss = NodeFS.readFileSync(
    NodePath.join(mobileRoot, "generated-uniwind-themes.css"),
    "utf8",
  );
  const themeColors = new Set(
    Array.from(themeCss.matchAll(/(--color-[a-z0-9-]+)\s*:/g), (match) => match[1]),
  );
  const themeNames: ReadonlyArray<string> = JSON.parse(
    NodeFS.readFileSync(NodePath.join(mobileRoot, "generated-uniwind-theme-names.json"), "utf8"),
  );
  const prelude = [
    ...["light", "dark", ...themeNames].map(
      (theme) => `@custom-variant ${theme} (&:where(.${theme}, .${theme} *));`,
    ),
    `@theme { ${Array.from(themeColors, (name) => `${name}: currentColor;`).join(" ")} }`,
  ].join("\n");
  const resolveStylesheet = (id: string, base: string) =>
    id === "tailwindcss"
      ? requireFromMobile.resolve("tailwindcss/index.css")
      : id === "uniwind"
        ? NodePath.join(
            NodePath.dirname(requireFromMobile.resolve("uniwind/package.json")),
            "uniwind.css",
          )
        : NodePath.resolve(base, id);
  return tailwind.__unstable__loadDesignSystem(
    `${prelude}\n${NodeFS.readFileSync(NodePath.join(mobileRoot, "global.css"), "utf8")}`,
    {
      base: mobileRoot,
      loadStylesheet: async (id, base) => {
        const path = resolveStylesheet(id, base);
        return { path, base: NodePath.dirname(path), content: NodeFS.readFileSync(path, "utf8") };
      },
    },
  );
}

function sourceStrings(file: string) {
  const absolute = NodePath.join(mobileRoot, file);
  const ast = babel.parseSync(NodeFS.readFileSync(absolute, "utf8"), {
    filename: absolute,
    cwd: mobileRoot,
    root: mobileRoot,
    caller: { name: "metro", bundler: "metro", platform: "ios" },
  });
  const strings: Array<{ readonly text: string; readonly className: boolean }> = [];
  babel.traverse(ast, {
    StringLiteral: (path) => {
      strings.push({
        text: path.node.value ?? "",
        className: path.parent.type === "JSXAttribute" && path.parent.name?.name === "className",
      });
    },
    TemplateLiteral: (path) => {
      strings.push({
        text: (path.node.quasis ?? []).map((quasi) => quasi.value.cooked ?? "").join(" "),
        className: false,
      });
    },
  });
  return strings;
}

const sourceFiles = NodeFS.readdirSync(NodePath.join(mobileRoot, "src"), { recursive: true })
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file))
  .map((file) => `src/${file.split(NodePath.sep).join("/")}`)
  .sort();

describe("mobile colour classes", () => {
  it("every colour class in mobile source exists in the theme or Tailwind's palette", async () => {
    const designSystem = await loadMobileDesignSystem();
    const undefinedClasses: Array<string> = [];
    for (const file of sourceFiles) {
      for (const { text, className } of sourceStrings(file)) {
        const tokens = text.split(/\s+/).filter((token) => CLASS_TOKEN.test(token));
        if (tokens.length === 0) continue;
        const css = designSystem.candidatesToCss(tokens);
        // A string is a class list when it sits in className or another of its tokens compiles.
        const classList = className || (tokens.length > 1 && css.some((rule) => rule !== null));
        if (!classList) continue;
        tokens.forEach((token, index) => {
          if (css[index] === null && COLOR_UTILITY.test(token))
            undefinedClasses.push(`${file}: ${token}`);
        });
      }
    }
    expect(undefinedClasses).toEqual([]);
  });
});
