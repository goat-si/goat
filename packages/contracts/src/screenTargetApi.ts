/**
 * The goat_screen_run guidance bundle: the cell API as TypeScript under one contract version.
 * A thread gets it with its first result, after a reset, a new provider session or a version
 * change, and when a surface first becomes available; it names only the surfaces the turn has.
 */
export const SCREEN_TARGET_CONTRACT_VERSION = "screen-target/1";

const HEADER = `// goat_screen_run cell API, contract ${SCREEN_TARGET_CONTRACT_VERSION}. Await every call, alone or in one Promise.all; the cell's return value comes back as JSON.
// Every target, tab or app, goes: observe, confirm it is the right target, act, observe the effect, check the task, then hand back or finish.
// unverifiable or any unknown outcome: observe again, never resend. Stop from the person ends the cell at once.`;

const COMMON = `type Target = number | string | [x: number, y: number] | { role?: string; name: string };
// number: [N] in the latest observe. string: a tab's Playwright selector or snapshot ref, or an app element's name.
// [x, y]: pixels of the current screenshot, for click, scroll and drag (both ends); input or a new page ends them. Numbers and refs hold until the next observe,
// and never move to another element: after navigation or a new document they fail with nothing sent.
type Done = { verdict: "confirmed" | "unverifiable"; result?: unknown };
// confirmed: done. unverifiable: may have landed. A refused or failed call, in any call form, throws
// ScreenError { code, message, nothingSent, effectStarted?, nextStep?, safety?, refused?, detail? };
// the cell's later input is then refused, but observe, read, status, waitFor and verify still run.
interface Observation { text: string; observationId: string; mode: "full" | "diff"; baseObservationId?: string;
  targetRef: { id: string; kind: "app" | "tab"; generation: number };
  targetGeneration: number; surfaceGeneration: number; // control and document generations; a change retires refs
  scope: string; complete: boolean; truncated: boolean; loading: boolean;
  omitted?: { kind: "frames" | "virtualized" | "pixels" | "budget"; detail?: string }[]; // absence there proves nothing
  resetReason?: string; // a diff that could not be compared came back full, never as "no change"
  elements: Element[]; title?: string; url?: string; image?: object }
interface Element { index: number; role: string; name: string; text?: string; actions?: string[];
  enabled?: boolean; selected?: boolean; frame?: { x: number; y: number; width: number; height: number };
  range?: { min: number; max: number }; parent?: number }
interface TargetBase { kind: "app" | "tab"; identity: string; environment: string; generation: number;
  owner?: string; // tabs: agent, unclaimed or human; profile and privacy are reported when the host knows them
  capabilities: string[]; note?: string; // note: GOAT's own notes for this app or site
  observe(o?: { diff?: boolean; screenshot?: boolean; interactiveOnly?: boolean }): Promise<Observation>; // tabs: a diff after the first; apps: always full
  click(t: Target, o?: { button?: "right"; count?: number }): Promise<Done>;
  type(text: string, t?: Target): Promise<Done>;
  press(key: string, t?: Target): Promise<Done>; // "Enter", "cmd+a"; a target is clicked first
  scroll(t: Target | null, direction: "up" | "down" | "left" | "right", amount?: number): Promise<Done>;
  setValue(t: Target, value: string): Promise<Done>;
  drag(from: Target, to: Target): Promise<Done>;
  waitFor(c: Condition, o?: { timeoutMs?: number }): Promise<{ met: boolean }>;
  verify(c: Condition): Promise<{ met: boolean }> }`;

const TAB = `// Tab Condition: { text } | { url } | { load: "load" | "domContentLoaded" | "networkIdle" } | { target }.
interface Tab extends TargetBase { status(): Promise<object>; claim(): Promise<object>; // tabs you opened need no claim
  goto(url: string): Promise<Done>; back(): Promise<Done>; forward(): Promise<Done>; reload(): Promise<Done>;
  read(): Promise<object>; fetch(url: string, o?: { format?: "markdown" | "text" }): Promise<object> }`;

const APP = `// App Condition: { role?, name?, value?, enabled?, selected? } | { window: "exists" | "gone" }.
// Steps already decided in one app window: start them together and await once, so they reach the app as
// one batch, in order: await Promise.all(["7", "+", "2", "="].map((k) => app.click(k)));
// An await on each call, as in a for loop, sends each alone. Each still gets its own result; the first failure stops the rest.
interface App extends TargetBase { menu(path: string[]): Promise<Done>; launch(): Promise<Done>;
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
