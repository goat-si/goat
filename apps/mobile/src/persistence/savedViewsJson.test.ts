import { expect, it } from "vite-plus/test";
import { savedViewsJsonValue } from "./savedViewsJson";

it("preserves the last top-level saved-view JSON value, including escapes and whitespace", () => {
  const raw =
    '{"nested":{"pullRequestSavedViews":0},"pullRequestSavedViews":["old"],"pullRequestSavedViews": [ { "name": "a\\\"}b", "items": [1,2] } ] ,"other":true}';
  expect(savedViewsJsonValue(raw)).toBe('[ { "name": "a\\\"}b", "items": [1,2] } ]');
  expect(savedViewsJsonValue('{"not":"present"}')).toBeUndefined();
});
