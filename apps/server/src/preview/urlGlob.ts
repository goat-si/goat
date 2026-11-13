// agent-browser's route_url_matches (cli/src/native/actions.rs:13600 at 1cc19526): `*` spans any
// run, `/` included, anchored where the pattern has no `*` at its edge; without `*`, a substring.
// A linear scan in Node with no RegExp: no pattern can backtrack, and none of it runs in the page.
export const matchesUrlGlob = (pattern: string, url: string): boolean => {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return url.includes(pattern);
  const collapsed = pattern.replace(/\*+/g, "*");
  const parts = collapsed.split("*").filter((part) => part.length > 0);
  const first = parts[0];
  const last = parts.at(-1);
  if (first === undefined || last === undefined) return true;
  let position = 0;
  let index = 0;
  if (!collapsed.startsWith("*")) {
    if (!url.startsWith(first)) return false;
    position = first.length;
    index = 1;
  }
  for (const part of parts.slice(index)) {
    const found = url.indexOf(part, position);
    if (found < 0) return false;
    position = found + part.length;
  }
  return collapsed.endsWith("*") || url.endsWith(last);
};
