/**
 * The goat_screen_run guidance bundle: the cell API as TypeScript under one contract version.
 * A thread gets it with its first result, after a reset, a new provider session or a version
 * change, and when a surface first becomes available; it names only the surfaces the turn has.
 */
export const SCREEN_TARGET_CONTRACT_VERSION = "screen-target/36";

const HEADER = `// goat_screen_run cell API, contract ${SCREEN_TARGET_CONTRACT_VERSION}. Await every call, alone or in one Promise.all; the cell's return value comes back as JSON.
// At most 4 calls wait for answers at once (pendingCalls); a fifth throws pending_limit with nothing sent: await some first.
// Every target goes: observe, confirm it is the right one, act, observe the effect, check the task, then hand back or finish.
// Stop from the person ends the cell at once.`;

const COMMON = `type ElementHandle = { readonly elementHandle: string }; // a copy is refused
type Target = ElementHandle | number | string | { window: [x: number, y: number] } | [x: number, y: number] | { role?: string; name: string } | { id: string };
// number: [N] in the latest observe. string: a tab's Playwright selector or snapshot ref, or an app element's name (reads once if needed).
// { id }: an app element's accessibility id, as its observation lists it; language-independent.
// { window: [x, y] }: macOS app window points from the window's top-left (the unit of app element frames), recommended first; [x, y]: pixels of the latest screenshot.
// macOS app points stay usable after input until the window moves or resizes (observe first after input that changed content); tab [x, y] survive clicks and end on other input, the next observe() or screenshot(), or a new page.
// Linux and Windows apps take points only in click: [x, y] pixels of a screenshot whose window position the driver proved (else unsupported, nothing sent), usable after input until the window moves, resizes or rescales (stale_reference: take a new screenshot); other app actions there use observe() numbers.
type Done = { ok: true; verdict: "confirmed" | "unverifiable" | "suspected_noop"; note?: string; warnings?: string[]; result?: { debug: { value?: unknown; evidence: string[] } } };
// suspected_noop: sent, but its effect was not seen; later inputs still run; observe when the next step depends on it.
// warnings: driver notes that may change what you believe (focus restoration, disabled actions).
// screen.debug = true adds diagnostic details to every input in this cell; verify: true on a supported app input reads evidence and adds details for that call.
type ReadTime = { ms?: number; phases?: { driverMs: number; parseMs: number; renderMs: number; bridgeMs: number } };
// Observation targetRef, targetGeneration, surfaceGeneration and phases are readable but non-enumerable (lost in spread, JSON and screen.values copies); screen.debug = true makes them enumerable and adds phases.hops to app reads when proxy timing is available.
// ReadTime (observe, screenshot): host time of the read (driver call or a tab's browser snapshot; tree parsing; rendering; the rest); absent if it would not fit the reply.
type Shot = { imageRef: string; pixelWidth: number; pixelHeight: number; omitted?: boolean; [k: string]: unknown };
// The picture returns as an image beside the cell's JSON under its imageRef; [x, y] count its pixels from the top-left. omitted: over the cell's image limit.
// A key (option, query or tab condition) a method below does not take is refused unsent (invalid_argument), naming those it takes.
// Diagnostic value: observed evidence and window reports when available.
// confirmed: the effect is proven. unverifiable: sent, its effect unproven and maybe already done,
// so observe before resending; still a success: go on and observe when you need the result. A refused or failed call, in any call form, throws
// ScreenError { code, message, nothingSent, effectStarted?, nextStep?, safety?, refused?, detail? };
// after nothingSent the cell goes on as before. GOAT refuses on its own only with strict input guards on (Settings > Computer use):
// a failed write that may have landed stops later input, and chat sends without { send: true },
// chat point clicks, paste and table name cells are refused unsent.
// nothingSent covers only its own call: a cell ending on it after an earlier input went out keeps
// that input's safety, and its nextStep names that input; read again before resending it.
// Pass { send: true } only on the final action that submits or sends a message, after the person confirmed;
// keep it off while typing a draft or pressing Enter to search. Never press cmd+v unless this cell copied the clipboard content itself.
// Diff text uses + added, ~ changed and - removed rows; unchanged rows keep their numbers. Tab focus changes use focus [N] or focus none.
// obs.ref(n) holds an element across awaits, passed as the target argument itself; refused unsent (stale_reference) after the target is read again (observe({after}) pages keep it). Bare numbers always mean the latest observation. Arguments are plain data.
interface Observation extends ReadTime { ref(n: number): ElementHandle; effect?: string; // first post-input diff: window evidence, not proof of the intended effect
  text: string; observationId: string; snapshot?: string; mode: "full" | "diff" | "query"; baseObservationId?: string;
  targetRef: { id: string; kind: "app" | "tab"; generation: number };
  targetGeneration: number; surfaceGeneration: number; // control and document generations; a change retires refs
  scope: string; complete: boolean; truncated: boolean; loading: boolean;
  omitted?: { kind: "frames" | "virtualized" | "pixels" | "budget"; detail?: string }[]; // absence there proves nothing
  resetReason?: string; // an unsafe diff, including tab frame refs, came back full, never as "no change"
  incompleteSearch?: boolean; // a query that could not search everything: a miss proves nothing
  rolesPresent?: string[]; // app role-query miss: up to 32 sorted bare roles from this read (filtered if the driver filtered)
  warnings?: string[]; // apps, as on Done
  otherWindows?: { window_id: number; title: string }[]; // apps: the app's other windows on screen, as this cell listed them
  title?: string; url?: string; image?: Shot } // image: with screenshot: true
interface TargetBase { kind: "app" | "tab"; identity: string; environment: string; generation: number;
  owner?: string; // tabs: agent, unclaimed or human; profile and privacy too when the host knows them
  capabilities: string[]; note?: string; // note: GOAT's own notes for this app or site
  observe(o?: { diff?: boolean; screenshot?: boolean; interactiveOnly?: boolean }): Promise<Observation>; // a diff after the first; app numbers from the latest full read stay valid until rows are added, removed or renumbered, then apply diffs and use the latest observation, or diff: false for the whole tree
  screenshot(): Promise<ReadTime & Shot>; // tabs: the image of observe({ screenshot: true }), no options; element numbers then need a new observe()
  click(t: Target, o?: { button?: "right"; count?: number; send?: boolean; timeoutMs?: number; checked?: boolean; action?: "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open" | "show_alternate_ui" | "show_default_ui" | string; modifiers?: ("cmd" | "shift" | "alt" | "ctrl")[]; verify?: boolean }): Promise<Done>; // tabs: count 1, 2 or 3; tabs only: timeoutMs waits for the target (5 s), checked sets a checkbox, radio or switch, clicking only when it differs; apps only: action. Tab verify adds diagnostics without extra reads. App verify: true reads the window list before and after the input, beside a read of the acted element when a unique label with text or selection names it; with no new window it relists up to 3 more times, 100 ms apart (4 for one that opens or closes a window). Element changes are evidence only; a window proven opened or closed confirms. A suspected_noop right after a whole observe gets one more window read whose changed rows confirm it (never a close); that read replaces earlier numbers
  type(text: string, t?: Target, o?: { send?: boolean; verify?: boolean }): Promise<Done>; // verify: as on click
  press(key: string, t?: Target, o?: { send?: boolean; verify?: boolean; holdMs?: number; delivery_mode?: "foreground" }): Promise<Done>; // "Enter", "cmd+a"; apps focus the target, tabs click it first; apps only: holdMs 0..30000 (driver support), foreground after a non-menu backgroundUnavailable refusal, not with send
  scroll(t: Target | null, direction: "up" | "down" | "left" | "right", amount?: number): Promise<Done>;
  setValue(t: Target, value: string): Promise<Done>;
  drag(from: Target, to: Target, o?: { send?: boolean; verify?: boolean }): Promise<Done>;
  waitFor(c: Condition, o?: number | { timeoutMs?: number }): Promise<{ met: boolean; download?: object }>; // tabs 15 s default, apps 10 s max; answers within the cell; download: the file a tab's { download: true } took
  verify(c: Condition): Promise<{ met: boolean }> }`;

const TAB = `// Tab Condition: { text } | { url } | { load: "load" | "domContentLoaded" | "networkIdle" } | { download: true } | { target } | { role, name? },
// and with target or role: enabled?, value?, checked?, selected? (true/false or exact value of the one match) and state?: "attached" | "detached" | "visible" | "hidden".
// url: a substring, or with * a glob of the whole URL (* spans anything, / included). download: one started after this tab's latest input has saved; each wait takes the next.
// text is visible page text, not the title. After goto, back, forward or reload the same tab acts on the new page.
// Never click a file input: upload() it. Custom dropdown: click, observe(), click the option.
// Read typed CJK or autocomplete text back before Enter.
// A canvas, map or drawing has no elements inside: click [x, y] from tab.screenshot(); other input retires those points (stale_reference: take a new one). scroll may leave the page moving.
// A selector still matching nothing 2 s after its page loaded throws target_missing, nothing sent; waitFor({ target }) waits for one that appears later.
interface Tab extends TargetBase { status(): Promise<object>; claim(): Promise<object>; // tabs you opened need no claim
  hover(t: Target, o?: { timeoutMs?: number }): Promise<Done>; // moves the pointer over it, showing hover-only controls; a selector matching several hovers the first
  goto(url: string): Promise<Done>; back(): Promise<Done>; forward(): Promise<Done>; reload(): Promise<Done>; close(): Promise<Done>; // close: a tab this agent opened
  read(): Promise<object>; fetch(url: string, o?: { format?: "markdown" | "text" }): Promise<object>; // fetch runs in the page, so its CORS and CSP apply; a failure's detail is cors, csp, dns or network
  fillLogin(secretRef: string, t?: Target): Promise<object>; fillCard(secretRef: string, t?: Target): Promise<object>;
  fillOneTimeCode(secretRef: string, t?: Target): Promise<object>;
  fillSecret(t: Target | { selector: string }, secretRef: string): Promise<object>; // observed elements and exact observed names are focused first; any other string is a CSS selector
  upload(t: Target, files: string[]): Promise<object>;
  dialog(action: "accept" | "dismiss", promptText?: string): Promise<object>;
  evaluate(expression: string): Promise<unknown>;
  logs(o?: { since?: string }): Promise<object> } // since is an inclusive ISO 8601 instant`;

const APP = `// App Condition: { role?, name?, value?, enabled?, selected? } | { window: "exists" | "gone" | "hidden" }. "gone" is met, and bound "closed", only when the driver proves the window closed.
// waitFor({gone: true, role?, name?}) is met only when a complete check of the window finds no match; name matches labels and values too. Otherwise { met: false, reason: "still_present" | "incomplete_read" }; on Windows the check is never complete.
// Narrow waitFor/verify with { role: "AXStaticText", value: "702" } or { value: "702" } when several elements share a role, or { name, value } when named.
// Decided steps in one app window: start them together and await once to send one GOAT-side group,
// each member an individual driver call, in order: await Promise.all(["7", "+", "2", "="].map((k) => app.click(k)));
// An await on each call, as in a for loop, sends each alone. Each gets its own result;
// with strict input guards on, later group members are not run after a failed step, so read every result: only a step whose own result says nothingSent went unsent.
// Bind a window an input opened (a chat, a document) from otherWindows to read it: screen.app({ bundle_id, window_id }).
// A large window keeps its toolbar and visible items first; omitted names what was left out and the next part,
// which app.observe({ after: n }) reads from the same read. app.observe({ query: { role?, name?, text?, id? } })
// searches up to 4,096 elements for matches on every field, with their ancestors as context.
// app.observe({ depth: 1..10 }) reads the window and shows it to that depth; "(+K)" counts children left out. app.observe({ within: n }) then shows [n]'s subtree from that same read, sending nothing, and keeps its numbers; a newer read or any input ends it.
interface App extends TargetBase { menu(path: string[], o?: { send?: boolean; verify?: boolean }): Promise<Done>; launch(): Promise<Done>;
  selectText(t: Target, text: string, o?: { occurrence?: number; prefix?: string; suffix?: string; selection?: "text" | "cursor_before" | "cursor_after" }): Promise<Done>;
  // selectText (macOS): selects text in a field named by number, id or role and name (never a point) without changing its value; the text must match once
  // unless a zero-based occurrence picks one (prefix and suffix narrow matches); cursor_before or cursor_after places the caret instead.
  windowId?: number; launched: boolean } // launched: screen.app started or reopened it`;

const SCREEN_TAB = `  tab(q: string | { tabId?: string; url?: string; mentionId?: string }): Promise<Tab>; // a string is a tab id or URL; reuse a matching open tab
  openTab(q: { url: string }): Promise<Tab>; // http(s) only; serve local files over http://127.0.0.1; an address that does not connect throws and closes its tab, or names it if it could not`;
const SCREEN_APP = `  // Native apps and browser dialogs only; web pages in any browser go through tab()/openTab(), never app().
  // app() without window_id: a running app with one window on screen binds it, never opening another; several
  // windows or processes are ambiguous; for a minimized or hidden window, pass the window_id screen.discover() lists with its title instead of opening a new one.
  // A closed app is launched in the background and its first window bound in the same call; a running
  // one is never relaunched, so with no window yet it throws: call app() again once one shows. The window is sought
  // for 5 s (a last check may take 2 s more); no window then throws, the app still running. Several
  // installed copies: a running one wins, else /Applications. A name shared by apps with different ids is ambiguous.
  // path: a launch_path list_apps lists (macOS) picks the copy to launch.
  // A string is the app's name, or its bundle id when no app has that name. bundleId and windowId are aliases.
  app(q: string | { bundle_id?: string; bundleId?: string; name?: string; path?: string; window_id?: number; windowId?: number }): Promise<App>;
  launch(q: { bundle_id?: string; name?: string; path?: string }): Promise<{ pid: number; windows: object[] }>; // starts it, binds nothing`;

const FOOTER = `// Batch decided steps in one cell and observe once at the end. A failed cell still returns its
// receipts; an uncaught host failure is reported as that call's receipt, and a cell that fails in its own
// code also returns value.partial: each call's return before the failure. Every cell outcome, result or error, carries windowsOpened (plus windowsOpenedTruncated, windowsOpenedUnverified): windows listed as newly opened for the apps the cell used.`;

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
    "  discover(): Promise<{ apps: unknown; windows: unknown; tabs: unknown; unavailable: object }>; // app and window rows another thread now uses carry inUse: true and holderThreadId (it may have just finished); holdersUnknown: true: some rows were not checked",
    "  state: object; // state values survive later turns until reset; targets survive cells of one turn, but targets must be bound again each turn; rebinding the same unmoved window returns the same target within a turn. A refused stale target names why and the call to bind it again.",
    "  debug: boolean; // initially false",
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
