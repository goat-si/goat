export function toBitbucketStates(
  state: "open" | "closed" | "merged" | "all",
): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "closed":
      return ["DECLINED", "SUPERSEDED"];
    case "merged":
      return ["MERGED"];
    case "all":
      return ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
  }
}

export function bitbucketQueryString(filters: ReadonlyArray<string>): string {
  return filters.join(" AND ");
}

export function bitbucketStateFilter(states: ReadonlyArray<string>): string {
  return states.length === 1
    ? `state = "${states[0]}"`
    : `(${states.map((state) => `state = "${state}"`).join(" OR ")})`;
}
