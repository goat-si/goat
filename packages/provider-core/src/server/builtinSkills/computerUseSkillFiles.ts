/**
 * GOAT's computer use skill as files on the machine that runs the driver, read on demand like any
 * other agent skill (agentskills.io progressive disclosure). The always-on sections in
 * computerUse.ts keep the rules a turn must never miss; the file holds the whole guide, and
 * per-app notes reach the agent with its first read of that app's window
 * (apps/server/src/cua/ComputerUseGuide.ts).
 */
import {
  COMPUTER_USE_PLATFORM_NOTES,
  COMPUTER_USE_SKILL_BATCH,
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
      "KakaoTalk: the chat list is a table whose rows can be selected in the background. Click the chat's cell by its `element_token` (it selects the row), then `press_key` Return to open the chat; a point click on the list is ignored in the background.",
      "Opening a chat marks its messages read for the sender. When the task only reads, read the chat list's previews and do not open the chat.",
      'In a chat, the message field is the `AXTextArea` labelled "Enter a message" ("Enter public message" in open chats, or a translation). Message bubbles are `AXTextArea` rows too, so pick the field by that label, `type_text` into it by its token and `press_key` Return to send. Older history shows as one "(offscreen rows: N ...)" line; if a read still misses the field, read again with `max_depth: 2`.',
      "After sending, read the chat again: the field is empty and the newest bubble shows your exact text. Otherwise say you could not confirm it was sent instead of sending again.",
      "Sending a message goes to other people: confirm the recipient and the text with the person first. Keys without a target and point clicks are refused here. To send, the call must say { send: true }, only when the person asked you to send that message to that chat.",
    ].join("\n"),
    TextEdit: [
      "TextEdit: a new document is saved to iCloud as soon as it exists; close it with cmd+w and choose Delete (DontSaveButton), then check the folder.",
    ].join("\n"),
    Preview: [
      "Preview: toolbar zoom buttons and menu shortcuts work in the background (command+plus, command+minus, command+9 fits the window). Text in a PDF page is drawn, not in the tree; use the screenshot to read it.",
    ].join("\n"),
    Safari: [
      "Safari: setting the address field's value does not load the page. Open a URL with File > Open Location (`invoke_menu`), type it and press Return; for web pages GOAT's own browser is usually the better tool.",
    ].join("\n"),
  },
};

/** Bundle ids of the apps above, so a note is found from either identity. */
const COMPUTER_USE_APP_BUNDLE_IDS: Readonly<Record<string, string>> = {
  "com.apple.finder": "Finder",
  "com.apple.systempreferences": "System Settings",
  "com.kakao.kakaotalkmac": "KakaoTalk",
  "com.apple.preview": "Preview",
  "com.apple.safari": "Safari",
  "com.apple.textedit": "TextEdit",
};

const SCREEN_CODE_APP_NOTES: Readonly<
  Partial<Record<NodeJS.Platform, Readonly<Record<string, string>>>>
> = {
  darwin: {
    Finder:
      'Finder: rows open with `app.click(n, { action: "open" })`; use arrow keys to select after selecting one item. If opening a folder fails, read the window title to confirm whether it moved before trying again; never resend blindly.',
    "System Settings":
      'System Settings: click a sidebar row to open its pane; `app.press("cmd+[")` goes back. Panes load lazily: `app.waitFor({ name: "element in the new pane" })` before acting. Never change privacy, security or account switches unless the person asked for that exact change.',
    KakaoTalk: [
      'KakaoTalk: click the chat list row, then `app.press("Enter")` to open it; background point clicks on the list are ignored.',
      "Opening a chat marks its messages read for the sender. When only reading, use the chat list previews and do not open the chat.",
      'In a chat, use `app.observe({ query: { role: "AXTextArea" } })` to find the message field (labelled "Enter a message" or "Enter public message", or a translation) and its id, distinguishing it from message bubbles. Type with `app.type(text, { id })` and check the draft.',
      'Sending goes to other people: confirm the recipient and the text with the person first. Use `app.press("Enter", { id }, { send: true })` only when the person asked to send that message to that chat.',
      "After sending, observe the chat and confirm the field is empty and the newest bubble contains the exact text before claiming success. If unconfirmed, say so and never send again.",
    ].join("\n"),
    TextEdit:
      'TextEdit: a new document is saved to iCloud as soon as it exists. Close your own document with `app.press("cmd+w")`, click the save sheet Delete button (`{ id: "DontSaveButton" }`), then check the folder.',
    Preview:
      'Preview: zoom shortcuts work in the background: command-plus, command-minus, and `app.press("cmd+9")` to fit. PDF text is drawn, not in the tree; use `app.screenshot()` to read it.',
    Safari:
      'Safari: setting the address field does not load the page. Use the GOAT browser, or `app.menu(["File", "Open Location"])`, type the URL and press Enter.',
  },
};

const frontmatter = [
  "---",
  "name: computer-use",
  "description: Operate app windows on the computer that runs GOAT with the cua-driver tools: observe one window, act in single calls or batches, verify at checkpoints. Read before the first computer use action of a turn.",
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
    COMPUTER_USE_SKILL_BATCH,
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

/** The notes for one app on this platform, by its name or bundle id, if GOAT has any. */
export function computerUseAppNote(
  platform: NodeJS.Platform,
  appName: string | undefined,
): string | undefined {
  if (appName === undefined) return undefined;
  const notes = COMPUTER_USE_APP_NOTES[platform];
  if (notes === undefined) return undefined;
  const bundle = appName.toLowerCase();
  const name = Object.hasOwn(COMPUTER_USE_APP_BUNDLE_IDS, bundle)
    ? COMPUTER_USE_APP_BUNDLE_IDS[bundle]
    : appName;
  return name !== undefined && Object.hasOwn(notes, name) ? notes[name] : undefined;
}

/** The screen-code guidance for one app, by name or bundle id. */
export function screenCodeAppNote(
  platform: NodeJS.Platform,
  appName: string | undefined,
): string | undefined {
  if (appName === undefined) return undefined;
  const notes = SCREEN_CODE_APP_NOTES[platform];
  if (notes === undefined) return undefined;
  const bundle = appName.toLowerCase();
  const name = Object.hasOwn(COMPUTER_USE_APP_BUNDLE_IDS, bundle)
    ? COMPUTER_USE_APP_BUNDLE_IDS[bundle]
    : appName;
  return name !== undefined && Object.hasOwn(notes, name) ? notes[name] : undefined;
}
