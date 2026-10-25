/**
 * GOAT's computer use skill as files on the machine that runs the driver, read on demand like any
 * other agent skill (agentskills.io progressive disclosure). The always-on sections in
 * computerUse.ts keep the rules a turn must never miss; the file holds the whole guide, and
 * per-app notes reach the agent with its first read of that app's window
 * (apps/server/src/cua/ComputerUseGuide.ts).
 */
import {
  COMPUTER_USE_PLATFORM_NOTES,
  COMPUTER_USE_SKILL_CORE,
  COMPUTER_USE_SKILL_PEOPLE,
} from "./computerUse.ts";

export const COMPUTER_USE_SKILL_DIRECTORY = "computer-use";
export const COMPUTER_USE_SKILL_FILE = "SKILL.md";

/** Notes for one app, keyed by the app name the driver reports for its windows. */
const COMPUTER_USE_APP_NOTES: Readonly<
  Partial<Record<NodeJS.Platform, Readonly<Record<string, string>>>>
> = {
  darwin: {
    Finder: [
      'Finder: list and icon rows are text fields that advertise only the open action, so a plain click or a point click does nothing there (suspected_noop). Open an item with `click` and `action: "open"`; select with the arrow keys after one item is selected.',
      "Opening a folder can answer tool_invocation_failed although the window already moved: read `list_windows` or the window title before trying again, never resend it blindly.",
    ].join("\n"),
    "System Settings": [
      "System Settings: sidebar rows open their pane with a click on the row; `hotkey` command+[ goes back. Panes load lazily, so read again (or `verify_state` for an element of the new pane) before acting on it.",
      "Never flip privacy, security or account switches unless the person asked for that exact change.",
    ].join("\n"),
    KakaoTalk: [
      "KakaoTalk: the chat list is a table whose rows can be selected in the background. Click the chat's cell by its `element_token` (it selects the row), then `press_key` Return to open the chat; a point click on the list is ignored in the background. In a chat, `type_text` into the message field by its token and `press_key` Return to send.",
      "Sending a message goes to other people: confirm the recipient and the text with the person first.",
    ].join("\n"),
    Preview: [
      "Preview: toolbar zoom buttons and menu shortcuts work in the background (command+plus, command+minus, command+9 fits the window). Text in a PDF page is drawn, not in the tree; use the screenshot to read it.",
    ].join("\n"),
  },
};

const frontmatter = [
  "---",
  "name: computer-use",
  "description: Operate app windows on the computer that runs GOAT with the cua-driver tools: observe one window, act once, verify. Read before the first computer use action of a turn.",
  "---",
].join("\n");

function appNotes(platform: NodeJS.Platform): string {
  const notes = COMPUTER_USE_APP_NOTES[platform];
  if (notes === undefined) return "";
  return Object.values(notes).join("\n\n");
}

/** The skill's files, relative to its directory, for this host's platform. */
export function computerUseSkillFiles(platform: NodeJS.Platform): Readonly<Record<string, string>> {
  const host = COMPUTER_USE_PLATFORM_NOTES[platform];
  const apps = appNotes(platform);
  const body = [
    frontmatter,
    COMPUTER_USE_SKILL_CORE,
    COMPUTER_USE_SKILL_PEOPLE,
    ...(host === undefined ? [] : [host]),
    ...(apps === ""
      ? []
      : ["## App notes\n\nRead `references/apps.md` for notes on specific apps."]),
  ].join("\n\n");
  return {
    [COMPUTER_USE_SKILL_FILE]: body + "\n",
    ...(apps === "" ? {} : { "references/apps.md": "# App notes\n\n" + apps + "\n" }),
  };
}

/** The notes for one app on this platform, if GOAT has any. */
export function computerUseAppNote(
  platform: NodeJS.Platform,
  appName: string | undefined,
): string | undefined {
  if (appName === undefined) return undefined;
  return COMPUTER_USE_APP_NOTES[platform]?.[appName];
}
