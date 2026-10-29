/**
 * The goat_screen_run guidance bundle: the cell API as TypeScript under one contract version.
 * A thread gets it with its first result, after a reset, a new provider session or a version
 * change, and when a surface first becomes available; it names only the surfaces the turn has.
 */
export const SCREEN_TARGET_CONTRACT_VERSION = "screen-target/3";

const HEADER = `// goat_screen_run cell API, contract ${SCREEN_TARGET_CONTRACT_VERSION}. Await every call, alone or in one Promise.all; the cell's return value comes back as JSON.
// Every target, tab or app, goes: observe, confirm it is the right target, act, observe the effect, check the task, then hand back or finish.
// unverifiable or any unknown outcome: observe again, never resend. Stop from the person ends the cell at once.`;

const COMMON = `type Target = number | string | { window: [x: number, y: number] } | [x: number, y: number] | { role?: string; name: string } | { id: string };
// number: [N] in the latest observe. string: a tab's Playwright selector or snapshot ref, or an app element's name (reads once if needed).
// { id }: an app element's accessibility id, as its observation lists it; the same in every language.
// { window: [x, y] }: macOS app window points from the window's top-left (the unit of element frames), recommended first; [x, y]: pixels of the latest screenshot.
// macOS app points stay usable after input until the window moves or resizes (after input that changed content, observe before using old points); tab and Linux/Windows [x, y] end on input or a new page.
type Done = { verdict: "confirmed" | "unverifiable"; point?: { x: number; y: number; unit: "window_points" }; hit?: unknown; result?: unknown };
// confirmed: done. unverifiable: may have landed. A refused or failed call, in any call form, throws
// ScreenError { code, message, nothingSent, effectStarted?, nextStep?, safety?, refused?, detail? };
// after nothingSent the cell goes on as before. A failed write that may have landed refuses the cell's
// later input, but observe, read, status, waitFor and verify still run.
interface Observation { text: string; observationId: string; mode: "full" | "diff" | "query"; baseObservationId?: string;
  targetRef: { id: string; kind: "app" | "tab"; generation: number };
  targetGeneration: number; surfaceGeneration: number; // control and document generations; a change retires refs
  scope: string; complete: boolean; truncated: boolean; loading: boolean;
  omitted?: { kind: "frames" | "virtualized" | "pixels" | "budget"; detail?: string }[]; // absence there proves nothing
  resetReason?: string; // a diff that could not be compared came back full, never as "no change"
  incompleteSearch?: boolean; // a query that could not search everything: a miss proves nothing
  elements: Element[]; title?: string; url?: string; image?: object }
interface Element { index: number; role: string; name: string; text?: string; actions?: string[];
  enabled?: boolean; selected?: boolean; frame?: { x: number; y: number; width: number; height: number };
  range?: { min: number; max: number }; parent?: number; id?: string }
interface TargetBase { kind: "app" | "tab"; identity: string; environment: string; generation: number;
  owner?: string; // tabs: agent, unclaimed or human; profile and privacy are reported when the host knows them
  capabilities: string[]; note?: string; // note: GOAT's own notes for this app or site
  observe(o?: { diff?: boolean; screenshot?: boolean; interactiveOnly?: boolean }): Promise<Observation>; // tabs: a diff after the first; apps: always full
  click(t: Target, o?: { button?: "right"; count?: number; send?: boolean }): Promise<Done>;
  type(text: string, t?: Target, o?: { send?: boolean }): Promise<Done>;
  press(key: string, t?: Target, o?: { send?: boolean }): Promise<Done>; // "Enter", "cmd+a"; apps focus the target, tabs click it first
  scroll(t: Target | null, direction: "up" | "down" | "left" | "right", amount?: number): Promise<Done>;
  setValue(t: Target, value: string): Promise<Done>;
  drag(from: Target, to: Target, o?: { send?: boolean }): Promise<Done>;
  waitFor(c: Condition, o?: number | { timeoutMs?: number }): Promise<{ met: boolean }>; // default 15 s; answers before the cell ends
  verify(c: Condition): Promise<{ met: boolean }> }`;

const TAB = `// Tab Condition: { text } | { url } | { load: "load" | "domContentLoaded" | "networkIdle" } | { target }.
// text is visible page text, not the title. After goto, back, forward or reload the same tab acts on the new page.
interface Tab extends TargetBase { status(): Promise<object>; claim(): Promise<object>; // tabs you opened need no claim
  goto(url: string): Promise<Done>; back(): Promise<Done>; forward(): Promise<Done>; reload(): Promise<Done>;
  read(): Promise<object>; fetch(url: string, o?: { format?: "markdown" | "text" }): Promise<object> }`;

const APP = `// App Condition: { role?, name?, value?, enabled?, selected? } | { window: "exists" | "gone" }.
// Steps already decided in one app window: start them together and await once, so they reach the app as
// one batch, in order: await Promise.all(["7", "+", "2", "="].map((k) => app.click(k)));
// An await on each call, as in a for loop, sends each alone. Each gets its own result, and
// after a failed or unknown one, later steps may already have run: read every result; a step went
// unsent only when its own result says nothingSent.
// A large window keeps its toolbar and visible items first; omitted names what it left out and the next part:
// app.observe({ after: n }) reads it from the same read. app.observe({ query: { role?, name?, text?, id? } })
// searches up to 4,096 elements for ones matching every field, with their ancestors as context.
interface App extends TargetBase { menu(path: string[], o?: { send?: boolean }): Promise<Done>; launch(): Promise<Done>;
  screenshot(): Promise<object> }`;

const SCREEN_TAB = `  tab(q: string | { tabId?: string; url?: string; mentionId?: string }): Promise<Tab>; // a string is a tab id or URL
  openTab(q: { url: string }): Promise<Tab>;`;
const SCREEN_APP = `  app(q: { bundle_id?: string; name?: string; window_id?: number }): Promise<App>; // window_id may be left out for a one-window app`;

const FOOTER = `// Batch decided steps in one cell and observe once at the end. A failed cell still returns its
// receipts; an uncaught host failure is reported as that call's receipt, and a cell that fails in its own
// code also returns value.partial: what each call returned before the failure.`;

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
    "  discover(): Promise<{ apps: unknown; windows: unknown; tabs: unknown; unavailable: object }>;",
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
