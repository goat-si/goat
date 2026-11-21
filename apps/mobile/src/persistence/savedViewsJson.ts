/** Locate the last top-level field value in an already-valid JSON object. */
export function savedViewsJsonValue(json: string): string | undefined {
  let i = 0;
  const whitespace = () => {
    while (/\s/u.test(json[i] ?? "") && i < json.length) i++;
  };
  const stringEnd = () => {
    i++;
    while (i < json.length) {
      if (json[i] === "\\") i += 2;
      else if (json[i++] === '"') return;
    }
  };
  const valueEnd = () => {
    if (json[i] === '"') return stringEnd();
    if (json[i] === "{" || json[i] === "[") {
      let depth = 0;
      do {
        const char = json[i];
        if (char === '"') stringEnd();
        else {
          if (char === "{" || char === "[") depth++;
          if (char === "}" || char === "]") depth--;
          i++;
        }
      } while (depth > 0 && i < json.length);
      return;
    }
    while (i < json.length && json[i] !== "," && json[i] !== "}") i++;
    while (i > 0 && /\s/u.test(json[i - 1] ?? "")) i--;
  };
  whitespace();
  if (json[i++] !== "{") return undefined;
  let result: string | undefined;
  while (i < json.length) {
    whitespace();
    if (json[i] === "}") break;
    const startKey = i;
    stringEnd();
    const key: unknown = JSON.parse(json.slice(startKey, i));
    whitespace();
    i++;
    whitespace();
    const start = i;
    valueEnd();
    if (key === "pullRequestSavedViews") result = json.slice(start, i);
    whitespace();
    if (json[i++] !== ",") break;
  }
  return result;
}
