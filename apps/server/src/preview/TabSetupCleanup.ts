export async function withTabSetupCleanup<T>(
  setup: (opened: Array<() => Promise<void>>) => Promise<T>,
): Promise<T> {
  const opened: Array<() => Promise<void>> = [];
  try {
    return await setup(opened);
  } catch (cause) {
    for (const close of opened.reverse()) await close().catch(() => {});
    throw cause;
  }
}

export async function connectDesktopPage<T>(options: {
  openScope: () => Promise<T>;
  endpoint: (scope: T) => Promise<string>;
  connect: (
    endpoint: string,
  ) => Promise<{ page: import("playwright-core").Page; browser: { close: () => Promise<void> } }>;
  closeScope: (scope: T) => Promise<void>;
}) {
  const scope = await options.openScope();
  try {
    const connected = await options.connect(await options.endpoint(scope));
    try {
      await connected.page.emulateMedia({ colorScheme: null });
    } catch (cause) {
      await connected.browser.close().catch(() => {});
      throw cause;
    }
    return {
      page: connected.page,
      close: async () => {
        await connected.browser.close().catch(() => {});
        await options.closeScope(scope);
      },
    };
  } catch (cause) {
    await options.closeScope(scope);
    throw cause;
  }
}
