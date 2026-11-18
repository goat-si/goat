import type { Browser, BrowserContext } from "playwright-core";
import { constVoid } from "effect/Function";

const BADGE_STUB = `if (typeof WorkerNavigator === "function") for (const name of ["setAppBadge", "clearAppBadge"]) WorkerNavigator.prototype[name] = () => Promise.resolve();`;

interface BadgeShimSession {
  send(method: string, params?: object): Promise<unknown>;
  createChildSession(...args: ReadonlyArray<unknown>): BadgeShimSession;
}

// The headless shell binds no BadgeService for service workers and kills the renderer of a
// worker that calls navigator.setAppBadge. Playwright resumes each worker itself, so the stub
// can only go in ahead of that resume through its in-process session; without it nothing is stubbed.
export const stubWorkerBadges = (client: Browser | BrowserContext) => {
  const { _connection: connection } = client as unknown as {
    readonly _connection?: {
      readonly toImpl?: (client: unknown) =>
        | {
            readonly _session?: BadgeShimSession;
            readonly _browser?: { readonly _session?: BadgeShimSession };
          }
        | undefined;
    };
  };
  const impl = connection?.toImpl?.(client);
  const root = impl?._browser?._session ?? impl?._session;
  if (!root) return;
  const createChildSession = root.createChildSession.bind(root);
  root.createChildSession = (...args) => {
    const session = createChildSession(...args);
    const send = session.send.bind(session);
    session.send = (method, params) => {
      if (method === "Runtime.runIfWaitingForDebugger") {
        void send("Runtime.evaluate", { expression: BADGE_STUB }).catch(constVoid);
      }
      return send(method, params);
    };
    return session;
  };
};
