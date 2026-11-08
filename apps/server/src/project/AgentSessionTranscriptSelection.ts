import type { ProviderInstanceId } from "@goat/contracts";

/** Round-robin across provider instances so one large home cannot crowd out the others. */
export function selectMetadataTranscripts<
  T extends { readonly providerInstanceId: ProviderInstanceId },
>(transcripts: ReadonlyArray<T>, limit: number): Array<T> {
  const selected: Array<T> = [];
  let pending = Array.from(
    Map.groupBy(transcripts, (transcript) => transcript.providerInstanceId).values(),
    (entries) => entries.values(),
  );
  while (pending.length > 0 && selected.length < limit) {
    const nextRound: typeof pending = [];
    for (const iterator of pending) {
      if (selected.length === limit) break;
      const next = iterator.next();
      if (next.done) continue;
      selected.push(next.value);
      nextRound.push(iterator);
    }
    pending = nextRound;
  }
  return selected;
}
