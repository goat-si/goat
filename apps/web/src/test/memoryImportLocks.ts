/** Models the browser lock manager across independent adapters, without timer polling. */
export function memoryImportTestLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request: <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const result = (tails.get(name) ?? Promise.resolve()).then(run);
      tails.set(
        name,
        result.catch(() => undefined),
      );
      return result;
    },
  };
}
