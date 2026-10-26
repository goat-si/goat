import { commands } from "vite-plus/test/browser";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Writes a line to the test runner's stderr. */
    reportMockFactoryFailure: (message: string) => Promise<void>;
  }
}

type FactoryMocker = { resolveFactoryModule: (url: string) => Promise<unknown> };

const describeError = (error: unknown) =>
  error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);

function describeChain(error: unknown) {
  const lines = [describeError(error)];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < 5; depth++) {
    lines.push(`Caused by: ${describeError(cause)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}

const installed = new WeakSet<object>();

/**
 * Reports why any `vi.mock` factory in the browser project rejected, then rethrows. Browser mode
 * sends only an error's name, message and stack back to the runner, so a failed factory otherwise
 * reaches CI as vitest's generic "error when mocking a module" with its cause and module dropped
 * (#928). The report goes to the runner's stderr: the default silent mode drops browser console
 * output from a file whose collection fails.
 *
 * `__vitest_mocker__` is vitest's private tester mocker. The Playwright route that serves a factory
 * mock asks it for the module through `resolveFactoryModule`, which is the path every #928 stack
 * shows.
 */
export function installMockFactoryFailureReport() {
  const mocker = (globalThis as { __vitest_mocker__?: Partial<FactoryMocker> }).__vitest_mocker__;
  const resolve = mocker?.resolveFactoryModule;
  if (mocker === undefined || typeof resolve !== "function") {
    // A vitest upgrade moved the hook; fail here rather than silently losing the report.
    throw new Error(
      "vitest no longer exposes __vitest_mocker__.resolveFactoryModule; update test/reportMockFactoryFailure.ts",
    );
  }
  // One tester iframe runs several files and setup files run for each of them.
  if (installed.has(mocker)) return;
  installed.add(mocker);
  mocker.resolveFactoryModule = async (url) => {
    try {
      return await resolve.call(mocker, url);
    } catch (error) {
      const file =
        (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath ??
        "an unknown test file";
      await commands
        .reportMockFactoryFailure(
          `vi.mock factory for ${url} failed while running ${file}: ${describeChain(error)}`,
        )
        .catch(() => undefined);
      throw error;
    }
  };
}
