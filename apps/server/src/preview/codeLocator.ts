/**
 * Reads a Playwright `getBy…(…)` call that an agent wrote as a locator string. Only a single call
 * with literal arguments and the options each call knows is read; anything else is refused before input, naming the accepted forms.
 *
 * @module codeLocator
 */
import type { Locator, Page } from "playwright-core";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

const OPTIONS = {
  Role: ["name", "exact"],
  Text: ["exact"],
  Label: ["exact"],
  Placeholder: ["exact"],
  AltText: ["exact"],
  Title: ["exact"],
  TestId: [],
} as const satisfies Record<string, ReadonlyArray<string>>;
type Kind = keyof typeof OPTIONS;

/** A quoted literal starting at `at`, or null for any escape other than a quote or backslash. */
const literal = (text: string, at: number) => {
  const quote = text[at];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  let value = "";
  for (let index = at + 1; index < text.length; index++) {
    const char = text[index];
    if (char === quote) return { value, end: index + 1 };
    if (char === "\\") {
      const next = text[++index];
      if (next === undefined || !"\\'\"`".includes(next)) return null;
      value += next;
    } else if (quote === "`" && char === "$" && text[index + 1] === "{") return null;
    else value += char;
  }
  return null;
};

/** The whole call, or null when any part of it is not a literal this reader knows. */
const parseCall = (text: string) => {
  let at = 0;
  const take = (pattern: RegExp) => {
    const sticky = new RegExp(pattern.source, "y");
    sticky.lastIndex = at;
    const match = sticky.exec(text);
    if (match) at = sticky.lastIndex;
    return match;
  };
  const string = () => {
    const read = literal(text, at);
    if (read) at = read.end;
    return read?.value;
  };
  const kind = take(
    /\s*(?:page\.)?getBy(Role|Text|Label|Placeholder|TestId|AltText|Title)\(\s*/,
  )?.[1] as Kind | undefined;
  const value = kind && string();
  if (!kind || value === undefined) return null;
  const options: { name?: string; exact?: boolean } = {};
  if (take(/\s*,\s*\{\s*/)) {
    while (!take(/\}\s*/)) {
      const key = take(/(\w+)\s*:\s*/)?.[1];
      if (!key || !(OPTIONS[kind] as ReadonlyArray<string>).includes(key) || key in options)
        return null;
      if (key === "exact") {
        const flag = take(/(true|false)\s*/)?.[1];
        if (!flag) return null;
        options.exact = flag === "true";
      } else {
        const name = string();
        if (name === undefined) return null;
        options.name = name;
        take(/\s*/);
      }
      if (!take(/,\s*/) && text[at] !== "}") return null;
    }
  }
  return take(/\s*\)\s*;?\s*$/) ? { kind, value, options } : null;
};

const unsupported = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationInvalidSelectorError",
    `Only one getByRole/Text/Label/Placeholder/TestId/AltText/Title call is read, with plain string literals and only the name and exact options. Use a snapshot ref, or a selector such as role=button[name="Save"].`,
  );

/** The locator for a `getBy…` call, null when the text is not one, or a refusal when it is malformed. */
export const codeLocator = (page: Page, text: string): Locator | null => {
  if (!/^\s*(?:page\.)?getBy[A-Z]/.test(text)) return null;
  const call = parseCall(text);
  if (!call) throw unsupported();
  const { kind, value, options } = call;
  const exact = options.exact === undefined ? {} : { exact: options.exact };
  switch (kind) {
    case "Role":
      return page.getByRole(value as Parameters<Page["getByRole"]>[0], {
        ...(options.name === undefined ? {} : { name: options.name }),
        ...exact,
      });
    case "Text":
      return page.getByText(value, exact);
    case "Label":
      return page.getByLabel(value, exact);
    case "Placeholder":
      return page.getByPlaceholder(value, exact);
    case "AltText":
      return page.getByAltText(value, exact);
    case "Title":
      return page.getByTitle(value, exact);
    default:
      return page.getByTestId(value);
  }
};
