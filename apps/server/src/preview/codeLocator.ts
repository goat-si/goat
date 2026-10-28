/**
 * Reads a Playwright `getBy…(…)` call that an agent wrote as a locator string. Only a single call
 * with literal arguments is read; anything else is refused before input, naming the accepted forms.
 *
 * @module codeLocator
 */
import type { Locator, Page } from "playwright-core";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

const CALL =
  /^\s*(?:page\.)?getBy(Role|Text|Label|Placeholder|TestId|AltText|Title)\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2\s*(?:,\s*\{([^{}]*)\}\s*)?\)\s*;?\s*$/s;
const STRING_OPTION = (key: string) =>
  new RegExp(`(?:^|[\\s,])${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`);
const BOOLEAN_OPTION = (key: string) => new RegExp(`(?:^|[\\s,])${key}\\s*:\\s*(true|false)`);

const unescape = (text: string) => text.replace(/\\(.)/g, "$1");

const unsupported = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationInvalidSelectorError",
    `Only one getByRole/Text/Label/Placeholder/TestId/AltText/Title call with literal arguments is read. Use a snapshot ref, or a selector such as role=button[name="Save"].`,
  );

/** The locator for a `getBy…` call, null when the text is not one, or a refusal when it is malformed. */
export const codeLocator = (page: Page, text: string): Locator | null => {
  if (!/^\s*(?:page\.)?getBy[A-Z]/.test(text)) return null;
  const call = CALL.exec(text);
  if (!call) throw unsupported();
  const [, kind, , rawValue, rawOptions = ""] = call;
  const value = unescape(rawValue ?? "");
  const name = STRING_OPTION("name").exec(rawOptions)?.[2];
  const exactText = BOOLEAN_OPTION("exact").exec(rawOptions)?.[1];
  const exact = exactText === undefined ? {} : { exact: exactText === "true" };
  switch (kind) {
    case "Role":
      return page.getByRole(value as Parameters<Page["getByRole"]>[0], {
        ...(name === undefined ? {} : { name: unescape(name) }),
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
