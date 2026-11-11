import type { MenuAction } from "@react-native-menu/menu";

const DIRECT_ACTIONS = new Set([
  "new-thread-on-branch",
  "fork",
  "fork:current",
  "copy-thread",
  "copy-thread-id",
  "settle",
  "unsettle",
  "unsnooze",
  "snooze",
  "pin",
  "unpin",
]);
const ARRANGEMENT_ACTIONS = new Set(["arrange", "move-up", "move-down"]);

export function layoutThreadRowMenu(actions: MenuAction[], nested: boolean): MenuAction[] {
  if (!nested || actions.length <= 5) return actions;
  const direct = actions.filter((action) => action.id && DIRECT_ACTIONS.has(action.id));
  const arrange = actions.filter((action) => action.id && ARRANGEMENT_ACTIONS.has(action.id));
  const secondary = actions.filter(
    (action) =>
      !action.id || (!DIRECT_ACTIONS.has(action.id) && !ARRANGEMENT_ACTIONS.has(action.id)),
  );
  const more = [
    ...(arrange.length > 1
      ? [
          {
            id: "arrange-menu",
            title: "Arrange",
            image: "arrow.up.arrow.down",
            subactions: arrange,
          },
        ]
      : arrange),
    ...secondary,
  ];
  return more.length
    ? [...direct, { id: "more", title: "More", image: "ellipsis.circle", subactions: more }]
    : direct;
}
