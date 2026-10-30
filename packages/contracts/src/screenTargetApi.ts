/**
 * The goat_screen_run guidance bundle: the cell API as TypeScript under one contract version.
 * A thread gets it with its first result, after a reset, a new provider session or a version
 * change, and when a surface first becomes available; it names only the surfaces the turn has.
 */
export const SCREEN_TARGET_CONTRACT_VERSION = "screen-target/18";

const HEADER = `// goat_screen_run cell API, contract ${SCREEN_TARGET_CONTRACT_VERSION}. Await every call, alone or in one Promise.all; the cell's return value comes back as JSON.
// Every target, tab or app, goes: observe, confirm it is the right target, act, observe the effect, check the task, then hand back or finish.
// An app input answers unverifiable when it went out and no proof of its effect was found: that is a success, so carry on and observe when you need to see the result. Never resend an input. Stop from the person ends the cell at once.`;

const COMMON = `type Target = number | string | { window: [x: number, y: number] } | [x: number, y: number] | { role?: string; name: string } | { id: string };
// number: [N] in the latest observe. string: a tab's Playwright selector or snapshot ref, or an app element's name (reads once if needed).
// { id }: an app element's accessibility id, as its observation lists it; the same in every language.
// { window: [x, y] }: macOS app window points from the window's top-left (the unit of app element frames), recommended first; [x, y]: pixels of the latest screenshot.
// macOS app points stay usable after input until the window moves or resizes (after input that changed content, observe before using old points); tab [x, y] survive clicks and end on any other input, the next observe() or screenshot(), or a new page; Linux and Windows app actions use element numbers from observe().
type Done = { verdict: "confirmed" | "unverifiable"; observed?: string[]; point?: { x: number; y: number; unit: "window_points" }; hit?: { role?: string; name?: string; id?: string } | null; ms?: number; phases?: { preMs?: number; driverMs: number; settleMs?: number; postMs?: number }; result?: { windows?: { opened: object[]; notListed: object[]; bound: "present" | "offscreen" | "not_listed" | "closed" | "unverified"; truncated?: boolean }; windowsTruncated?: boolean; [k: string]: unknown } };
// ms and phases: host time of this call (the driver or browser call; an app's first input on a process in a cell adds preMs, one window read for the cell's baseline; with verify, the post-reads too, and a settle wait when an element is read); absent for steps sent as one batch.
type ReadTime = { ms?: number; phases?: { driverMs: number; parseMs: number; renderMs: number; bridgeMs: number } };
// ReadTime on observe and screenshot: host time of the read (the driver call, for a tab the browser's snapshot; tree parsing; rendering; the rest); absent when it would not fit the reply.
type Shot = { imageRef: string; pixelWidth: number; pixelHeight: number; omitted?: boolean; [k: string]: unknown };
// The picture comes back as an image beside the cell's JSON, under its imageRef; [x, y] count its pixels from the top-left. omitted: it did not fit the cell's image limit.
// An option, query or tab condition key a method below does not take is refused unsent (invalid_argument), naming the keys it takes.
// App observed lists only the acted element's own state change; read other elements with observe(). An input carries observed evidence and a windows report only when it passes verify: true or opens a Go to Folder sheet.
// confirmed: the effect is proven. unverifiable: the input was sent and no proof of its effect was found; it may already have taken effect,
// so never resend it. Nothing waits on it: go on with the next step and observe when you need the result. A refused or failed call, in any call form, throws
// ScreenError { code, message, nothingSent, effectStarted?, nextStep?, safety?, refused?, detail? };
// after nothingSent the cell goes on as before. A failed write that may have landed refuses the cell's
// later input, but observe, read, status, waitFor and verify still run.
// nothingSent speaks for its own call only: a cell that ends on it after an earlier input went out keeps
// that input's safety, and its nextStep names the input; read again in a new cell and never resend it.
// Pass { send: true } only on the final action that submits or sends a message after the person confirmed;
// keep it off while typing a draft or pressing Enter to search, and never press cmd+v unless this cell copied the clipboard content itself.
// Diff text uses + added, ~ changed and - removed rows; unchanged numbers remain valid.
interface Observation extends ReadTime { text: string; observationId: string; snapshot?: string; mode: "full" | "diff" | "query"; baseObservationId?: string;
  targetRef: { id: string; kind: "app" | "tab"; generation: number };
  targetGeneration: number; surfaceGeneration: number; // control and document generations; a change retires refs
  scope: string; complete: boolean; truncated: boolean; loading: boolean;
  omitted?: { kind: "frames" | "virtualized" | "pixels" | "budget"; detail?: string }[]; // absence there proves nothing
  resetReason?: string; // an unsafe diff, including tab frame refs, came back full, never as "no change"
  incompleteSearch?: boolean; // a query that could not search everything: a miss proves nothing
  title?: string; url?: string; image?: Shot } // image: with screenshot: true
interface TargetBase { kind: "app" | "tab"; identity: string; environment: string; generation: number;
  owner?: string; // tabs: agent, unclaimed or human; profile and privacy are reported when the host knows them
  capabilities: string[]; note?: string; // note: GOAT's own notes for this app or site
  observe(o?: { diff?: boolean; screenshot?: boolean; interactiveOnly?: boolean }): Promise<Observation>; // a diff after the first; app numbers from the latest full read remain valid until rows are added, removed or renumbered; then apply diffs and use the latest observation, or diff: false for the whole tree
  screenshot(): Promise<ReadTime & Shot>; // tabs: the image of observe({ screenshot: true }), no options; element numbers then need a new observe()
  click(t: Target, o?: { button?: "right"; count?: number; send?: boolean; timeoutMs?: number; action?: "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open" | "show_alternate_ui" | "show_default_ui" | string; modifiers?: ("cmd" | "shift" | "alt" | "ctrl")[]; verify?: boolean }): Promise<Done>; // tabs: count 1, 2 or 3; timeoutMs (tabs only) waits for the target, 5 s; action, modifiers and verify are apps only; tabs refuse modifiers. verify: true reads the app's window list before and after the input, run side by side with the acted element's read when a unique label with text or selection names it (a 60 ms settle follows that first read when the cell has time); an input that opens or closes a window may list windows up to four more times. observed: lines are evidence, not a verdict: only a window it proves opened or closed makes the verdict confirmed
  type(text: string, t?: Target, o?: { send?: boolean; verify?: boolean }): Promise<Done>; // verify: apps only, as on click
  press(key: string, t?: Target, o?: { send?: boolean; verify?: boolean; holdMs?: number }): Promise<Done>; // "Enter", "cmd+a"; apps focus the target, tabs click it first; holdMs 0..30000 needs a supporting app driver; tabs refuse it
  scroll(t: Target | null, direction: "up" | "down" | "left" | "right", amount?: number): Promise<Done>;
  setValue(t: Target, value: string): Promise<Done>;
  drag(from: Target, to: Target, o?: { send?: boolean; verify?: boolean }): Promise<Done>;
  waitFor(c: Condition, o?: number | { timeoutMs?: number }): Promise<{ met: boolean }>; // default 15 s; answers before the cell ends
  verify(c: Condition): Promise<{ met: boolean }> }`;

const TAB = `// Tab Condition: { text } | { url } | { load: "load" | "domContentLoaded" | "networkIdle" } | { target } | { role, name? },
// and with target or role: enabled?, value?, checked?, selected? (true/false or exact value of the one match) and state?: "attached" | "detached" | "visible" | "hidden".
// text is visible page text, not the title. After goto, back, forward or reload the same tab acts on the new page.
// A canvas, map or drawing has no elements inside it: click its spot at [x, y] from tab.screenshot(). Any input but a click retires those points (stale_reference): take a new one. scroll's result.settled false: the page may still be moving.
interface Tab extends TargetBase { status(): Promise<object>; claim(): Promise<object>; // tabs you opened need no claim
  hover(t: Target, o?: { timeoutMs?: number }): Promise<Done>; // moves the pointer over it, showing hover-only controls; a selector matching several hovers the first
  goto(url: string): Promise<Done>; back(): Promise<Done>; forward(): Promise<Done>; reload(): Promise<Done>;
  read(): Promise<object>; fetch(url: string, o?: { format?: "markdown" | "text" }): Promise<object> }`;

const APP = `// App Condition: { role?, name?, value?, enabled?, selected? } | { window: "exists" | "gone" | "hidden" }. "gone" is met, and bound "closed", only when the driver proves the window closed.
// Narrow waitFor/verify with { role: "AXStaticText", value: "702" } or { value: "702" } when several elements share a role, or { name, value } when named.
// Steps already decided in one app window: start them together and await once, so they reach the app as
// one GOAT-side group; each member is an individual driver call, in order: await Promise.all(["7", "+", "2", "="].map((k) => app.click(k)));
// An await on each call, as in a for loop, sends each alone. Each gets its own result, and
// after a failed step, later group members are not run: read every result; a step went
// unsent only when its own result says nothingSent.
// A large window keeps its toolbar and visible items first; omitted names what it left out and the next part:
// app.observe({ after: n }) reads it from the same read. app.observe({ query: { role?, name?, text?, id? } })
// searches up to 4,096 elements for ones matching every field, with their ancestors as context.
interface App extends TargetBase { menu(path: string[], o?: { send?: boolean; verify?: boolean }): Promise<Done>; launch(): Promise<Done>;
  selectText(t: Target, text: string, o?: { occurrence?: number; prefix?: string; suffix?: string; selection?: "text" | "cursor_before" | "cursor_after" }): Promise<Done>;
  // selectText (macOS): selects text inside a field named by number, id or role and name, never a point, leaving its value as is; the text must match once
  // unless a zero-based occurrence picks one (prefix and suffix narrow the matches); cursor_before or cursor_after places the caret there instead.
  windowId?: number; launched: boolean } // launched: screen.app started or reopened it`;

const SCREEN_TAB = `  tab(q: string | { tabId?: string; url?: string; mentionId?: string }): Promise<Tab>; // a string is a tab id or URL
  openTab(q: { url: string }): Promise<Tab>; // http(s) only; serve local files over http://127.0.0.1; an address that does not connect throws and closes its tab, or names it if it could not`;
const SCREEN_APP = `  // app() without window_id: a running app with one window on screen binds it, never opening another; several
  // windows or processes are ambiguous; for a minimized or hidden window, check screen.discover() for its window_id and title and pass window_id explicitly instead of opening a new window.
  // A closed app is launched in the background and bound to its first window in the same call; a running
  // one is never launched again, so with no window yet it throws: call app() again once it shows one. It is looked for during 5 s, and a
  // last check started then may take 2 s more; no window then throws, with the app still running. Several
  // installed copies: a running one wins, else /Applications. A name shared by apps with different ids is ambiguous.
  // path: a launch_path list_apps lists (macOS) picks the copy to launch.
  app(q: string | { bundle_id?: string; name?: string; path?: string; window_id?: number }): Promise<App>;
  launch(q: { bundle_id?: string; name?: string; path?: string }): Promise<{ pid: number; windows: object[] }>; // starts it, binds nothing`;

const FOOTER = `// Batch decided steps in one cell and observe once at the end. A failed cell still returns its
// receipts; an uncaught host failure is reported as that call's receipt, and a cell that fails in its own
// code also returns value.partial: what each call returned before the failure. The cell outcome (result or error) also carries windowsOpened (plus windowsOpenedTruncated, windowsOpenedUnverified): windows listed as newly opened for the apps the cell used.`;

/** The bundle for the surfaces a turn has now; an absent surface is named as unavailable. */
export const screenTargetApi = (surfaces: {
  readonly app: boolean;
  readonly tab: boolean;
}): string => {
  const { app, tab } = surfaces;
  return [
    HEADER,
    COMMON,
    ...(tab ? [TAB] : []),
    ...(app ? [APP] : []),
    "declare const screen: {",
    ...(app ? [SCREEN_APP] : []),
    ...(tab ? [SCREEN_TAB] : []),
    "  discover(): Promise<{ apps: unknown; windows: unknown; tabs: unknown; unavailable: object }>; // app and window rows another thread uses now carry inUse: true and holderThreadId (it may have just finished); holdersUnknown: true means some rows could not be checked",
    "  state: object; // survives cells of this turn",
    "};",
    ...(app
      ? []
      : [
          "// No desktop app surface here: screen.app() is unavailable; hand app steps to the person.",
        ]),
    ...(tab ? [] : ["// No browser surface here: screen.tab() is unavailable."]),
    FOOTER,
  ].join("\n");
};

export const SCREEN_TARGET_API = screenTargetApi({ app: true, tab: true });
