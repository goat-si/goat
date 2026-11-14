export function withoutHistoryArchive<T extends { readonly historyArchive?: unknown }>(thread: T) {
  const { historyArchive: _historyArchive, ...rest } = thread;
  return rest;
}
