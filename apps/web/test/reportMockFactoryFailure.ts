import { commands } from "vite-plus/test/browser";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Writes a line to the test runner's stderr. */
    reportMockFactoryFailure: (message: string) => Promise<void>;
  }
}

const describeError = (error: unknown) =>
  error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);

/**
 * Imports the real module behind a partial `vi.mock` factory and reports why it failed before
 * rethrowing. Browser mode sends only an error's name, message and stack back to the runner, so a
 * failed `original()` otherwise reaches CI as vitest's generic "error when mocking a module" with
 * its cause dropped (#928). The report goes to the runner's stderr: the default silent mode drops
 * browser console output from a file whose collection fails.
 */
export async function reportMockFactoryFailure<T>(path: string, load: () => Promise<T>) {
  try {
    return await load();
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    await commands
      .reportMockFactoryFailure(
        `vi.mock factory for ${path} could not import the real module: ${describeError(error)}` +
          (cause === undefined ? "" : `\nCaused by: ${describeError(cause)}`),
      )
      .catch(() => undefined);
    throw error;
  }
}
