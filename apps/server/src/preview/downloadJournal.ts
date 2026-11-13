import { ServerBrowserOperationError } from "./browserOperationError.ts";

/** A file the tab saved, as status lists it. */
export interface SavedDownload {
  readonly fileName: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly completedAt: string;
}

interface Entry {
  readonly input: number;
  state: "running" | "saved" | "failed";
  file?: SavedDownload;
  reason?: string;
  claimed: boolean;
}

/** Twice the files a tab keeps, so a download still running outlives evictions of saved ones. */
const KEPT = 40;

const unsaved = (reason: string) =>
  new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    `The download did not save: ${reason}.`,
  );

/**
 * A tab's downloads, each tagged with how many agent inputs had started when it began, so a wait
 * asks for one since the latest input without timestamps that move when that input ends. A wait
 * claims what it returns only once it succeeds, so the next wait after the same input gets the next
 * download; a failure is reported to one wait and then passed over.
 */
export class DownloadJournal {
  private inputs = 0;
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<() => void>();

  /** Counts an agent input as it starts and hands its attribution back, so callers stay one line. */
  input<A>(attribution: A): A {
    this.inputs++;
    return attribution;
  }

  get latestInput() {
    return this.inputs;
  }

  started() {
    const entry: Entry = { input: this.inputs, state: "running", claimed: false };
    this.entries.push(entry);
    const oldest = this.entries.length > KEPT ? this.entries[0] : undefined;
    if (oldest !== undefined) {
      // A wait on the dropped entry must fail, not hang, so it settles while waits can still find it.
      if (!oldest.claimed)
        this.settle(oldest, "failed", {
          reason: `more than ${KEPT} downloads started before a wait took it`,
        });
      this.entries.shift();
    }
    return {
      saved: (file: SavedDownload) => this.settle(entry, "saved", { file }),
      failed: (reason: string) => this.settle(entry, "failed", { reason }),
    };
  }

  /**
   * The earliest unclaimed download started since input number `since`, once it saved. A wait
   * that may not claim (one that only observes the tab) reports a failure without taking it.
   */
  wait(
    since: number,
    signal: AbortSignal,
    kept: (file: SavedDownload) => boolean,
    claims = true,
  ): Promise<{ readonly file: SavedDownload; readonly claim: () => void }> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const entry = this.entries.find((each) => each.input >= since && !each.claimed);
        if (entry === undefined || entry.state === "running") return;
        stop();
        // The tab deletes its oldest files; one gone before a wait took it cannot be returned.
        if (entry.state === "saved" && entry.file !== undefined && kept(entry.file)) {
          const file = entry.file;
          return resolve({ file, claim: () => void (entry.claimed = true) });
        }
        if (claims) entry.claimed = true;
        reject(
          unsaved(
            entry.state === "saved"
              ? "it was deleted before a wait took it"
              : (entry.reason ?? "it failed"),
          ),
        );
      };
      const abort = () => {
        stop();
        reject(signal.reason);
      };
      const stop = () => {
        this.listeners.delete(check);
        signal.removeEventListener("abort", abort);
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      this.listeners.add(check);
      check();
    });
  }

  private settle(entry: Entry, state: "saved" | "failed", fields: Pick<Entry, "file" | "reason">) {
    entry.state = state;
    Object.assign(entry, fields);
    for (const listener of this.listeners) listener();
  }
}

const journals = new WeakMap<object, DownloadJournal>();

/** One journal per tab, made on first use, so the upstream tab shape stays as it is. */
export const downloadJournal = (tab: object) => {
  const journal = journals.get(tab) ?? new DownloadJournal();
  journals.set(tab, journal);
  return journal;
};

interface DownloadsTab {
  readonly downloads: ReadonlyArray<SavedDownload>;
}

/**
 * What a download wait needs: the journal, the input count as the wait began and the files kept.
 * A wait that only observes the tab (another agent's, or one a person drives) takes nothing.
 */
export const downloadsOf = (tab: DownloadsTab, observing = false) => {
  const journal = downloadJournal(tab);
  return {
    journal,
    since: journal.latestInput,
    kept: (file: SavedDownload) => tab.downloads.some((each) => each === file),
    claims: !observing,
  };
};
/** confirm: the caller's last check before a wait takes its download; a throw leaves it there. */
export type DownloadWait = ReturnType<typeof downloadsOf> & { readonly confirm?: () => void };

/**
 * Journals one download around the tab's own save: the entry settles with the record that save
 * returns, or fails when it saved none (a failed, cancelled or oversized download, or a closing tab).
 */
export const journalDownload = async <T extends object, D>(
  tab: T,
  download: D,
  save: (tab: T, download: D) => Promise<SavedDownload | undefined>,
) => {
  const entry = downloadJournal(tab).started();
  const saved = await save(tab, download).catch(() => undefined);
  if (saved === undefined)
    entry.failed("it failed, was cancelled, was too large or its tab closed");
  else entry.saved(saved);
};
