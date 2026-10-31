import { forgetGoneApp, learnApps, type ListedApp } from "./ComputerUseScope.ts";

export const makeIdentityCache = () => {
  const listed = new Map<number, ListedApp>();
  let epoch: number | undefined;
  const scope = (
    before: ReadonlySet<string> | undefined,
    after: ReadonlySet<string> | undefined,
  ) => {
    if (
      (before === undefined) !== (after === undefined) ||
      (before !== undefined &&
        after !== undefined &&
        (before.size !== after.size || [...before].some((app) => !after.has(app))))
    )
      listed.clear();
  };
  const turn = (next: number, reset: boolean) => {
    if (reset || (epoch !== undefined && next !== epoch)) listed.clear();
    epoch = next;
  };
  const learn = (
    value: unknown,
    listing: boolean,
    executableOf?: Parameters<typeof learnApps>[3],
    labels?: Parameters<typeof learnApps>[4],
  ) => {
    if (listing) listed.clear();
    learnApps(value, listed, listing, executableOf, labels);
  };
  return {
    listed,
    scope,
    turn,
    learn,
    forget: (value: unknown, args: unknown) => forgetGoneApp(value, args, listed),
    clear: () => listed.clear(),
  };
};
