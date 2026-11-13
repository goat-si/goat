import { expect, it } from "vite-plus/test";
import { matchesUrlGlob } from "./urlGlob.ts";

// agent-browser's own cases (cli/src/native/actions.rs:22076-22118 at 1cc19526) come first.
const cases: ReadonlyArray<readonly [pattern: string, url: string, matches: boolean]> = [
  ["**/api/users", "https://app.example.com/v1/api/users", true],
  ["**/analytics/**", "https://cdn.example.com/analytics/event.js", true],
  ["https://example.com/*/users", "https://example.com/api/users", true],
  ["**/api/users", "https://app.example.com/v1/api/users/42", false],
  ["**/analytics/**", "https://cdn.example.com/static/event.js", false],
  ["**/the-edge-of-the-page", "http://localhost:3001/the-edge-of-the-page", true],
  ["**/dashboard", "http://localhost:3000/dashboard", true],
  ["/dashboard", "http://localhost:3000/dashboard", true],
  ["**/dashboard", "http://localhost:3000/settings", false],
  ["*", "about:blank", true],
  ["https://a.test/?q=1", "https://a.test/?q=1&x=2", true],
  ["https://a.test/*", "http://a.test/x", false],
  ["https://a.test/*.js", "https://a.test/x/y.js", true],
  ["https://a.test/*.js", "https://a.test/x/yxjs", false],
  ["**/done*", "https://app.test/flow/done?step=3", true],
  ["a*a", "a", false],
];

it.each(cases)(
  "%s against %s matches: %s, as agent-browser's route_url_matches",
  (pattern, url, matches) => {
    expect(matchesUrlGlob(pattern, url)).toBe(matches);
  },
);

it("a pattern that would backtrack in a RegExp answers in one linear pass", () => {
  // A backtracking matcher takes exponential time here; the linear scan settles at the first miss.
  expect(matchesUrlGlob("*a*a*a*a*a*a*a*a*a*a*b", `https://${"a".repeat(200_000)}`)).toBe(false);
});
