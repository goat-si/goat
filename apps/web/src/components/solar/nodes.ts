/**
 * Solar Linear glyph data for code that draws icons itself, such as MorphIcon. React
 * call sites import components from `~/components/solar` instead.
 */
import type { IconNode } from "./iconNode";
import * as solar from "./solar.generated";

export const Box = solar.box;
export const Check = solar.check;
export const ChevronDown = solar.altArrowDown;
export const ChevronRight = solar.altArrowRight;
export const ChevronUp = solar.altArrowUp;
export const ChevronsDownUp = solar.chevronsDownUp;
export const ChevronsUpDown = solar.chevronsUpDown;
export const Circle = solar.record;
export const CircleAlert = solar.dangerCircle;
export const CircleCheck = solar.checkCircle;
export const Code = solar.code;
export const Copy = solar.copy;
export const Keyboard = solar.keyboard;
export const CornerUpRight = solar.forward;
export const Eye = solar.eye;
export const Folder = solar.folder;
export const FolderOpen = solar.folderOpen;
export const Image = solar.gallery;
export const Link = solar.link;
export const ListPlus = solar.listPlus;
export const Lock = solar.lock;
export const LockOpen = solar.lockUnlocked;
export const Maximize = solar.maximize;
export const Minimize = solar.minimize;
export const Minus = solar.minus;
export const Moon = solar.moon;
export const PanelLeft = solar.panelLeft;
export const PanelLeftClose = solar.panelLeftClose;
export const Plus = solar.add;
export const Sun = solar.sun;
export const Table = solar.table;
export const Text = solar.text;
export const Volume = solar.volumeLoud;
export const VolumeOff = solar.volumeCross;

/** Context menu glyphs keyed by the icon names that `ContextMenuItem.icon` carries. */
export const CONTEXT_MENU_ICONS: Readonly<Record<string, IconNode>> = {
  archive: solar.archive,
  check: solar.check,
  "arrow-up-from-line": solar.arrowUpFromLine,
  timer: solar.stopwatch,
  "chevron-right": solar.altArrowRight,
  "circle-check": solar.checkCircle,
  clock: solar.clockCircle,
  pencil: solar.pen,
  copy: solar.copy,
  folder: solar.folder,
  "git-branch": solar.gitBranch,
  hash: solar.hashtag,
  "mail-open": solar.letterOpened,
  "message-square-plus": solar.chatRoundAdd,
  pin: solar.pin,
  "pin-off": solar.pin,
  "refresh-cw": solar.refresh,
  settings: solar.settings,
  "folder-tree": solar.folderTree,
  trash: solar.trashBinMinimalistic,
};

/** Static SVG markup for surfaces that inject HTML, such as inline composer chips. */
export function iconSvgMarkup(node: IconNode): string {
  const children = node
    .map(([tag, attrs]) => {
      const attributes = Object.entries(attrs)
        .map(([name, value]) => " " + name + '="' + value + '"')
        .join("");
      return "<" + tag + attributes + "/>";
    })
    .join("");
  return (
    '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
    children +
    "</svg>"
  );
}
