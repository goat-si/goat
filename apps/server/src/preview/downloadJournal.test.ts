import { expect, it } from "vite-plus/test";
import {
  DownloadJournal,
  downloadJournal,
  journalDownload,
  type SavedDownload,
} from "./downloadJournal.ts";

const file = (name: string): SavedDownload => ({
  fileName: name,
  path: `/artifacts/${name}`,
  sizeBytes: 3,
  url: `https://files.test/${name}`,
  completedAt: "2026-11-13T00:00:00.000Z",
});
const always = () => true;
const live = () => new AbortController().signal;

it("a download saved before the latest agent input is passed over for the next one", async () => {
  const journal = new DownloadJournal();
  journal.started().saved(file("old.csv"));
  journal.input("click");
  const waiting = journal.wait(journal.latestInput, live(), always);
  journal.started().saved(file("new.csv"));
  expect((await waiting).file.fileName).toBe("new.csv");
});

it("a download that saved after the input but before the wait began is returned", async () => {
  const journal = new DownloadJournal();
  journal.input("click");
  journal.started().saved(file("early.csv"));
  expect((await journal.wait(1, live(), always)).file.fileName).toBe("early.csv");
});

it("a wait that took its download moves the next wait on; one that did not leaves it there", async () => {
  const journal = new DownloadJournal();
  journal.input("click");
  journal.started().saved(file("a.csv"));
  journal.started().saved(file("b.csv"));
  const unclaimed = await journal.wait(1, live(), always);
  expect(unclaimed.file.fileName).toBe("a.csv");
  const taken = await journal.wait(1, live(), always);
  expect(taken.file.fileName).toBe("a.csv");
  taken.claim();
  expect((await journal.wait(1, live(), always)).file.fileName).toBe("b.csv");
});

it("a failed download fails one wait with its reason, and the next wait passes over it", async () => {
  const journal = new DownloadJournal();
  journal.input("click");
  journal.started().failed("it was cancelled");
  await expect(journal.wait(1, live(), always)).rejects.toMatchObject({
    tag: "PreviewAutomationExecutionError",
    message: "The download did not save: it was cancelled.",
  });
  journal.started().saved(file("retry.csv"));
  expect((await journal.wait(1, live(), always)).file.fileName).toBe("retry.csv");
});

it("a file the tab deleted before any wait took it fails the wait", async () => {
  const journal = new DownloadJournal();
  journal.started().saved(file("gone.csv"));
  await expect(journal.wait(0, live(), () => false)).rejects.toThrow(
    "The download did not save: it was deleted before a wait took it.",
  );
});

it("an aborted wait takes nothing, so the next wait still gets that download", async () => {
  const journal = new DownloadJournal();
  const stop = new AbortController();
  const waiting = journal.wait(0, stop.signal, always);
  stop.abort(new Error("taken over"));
  await expect(waiting).rejects.toThrow("taken over");
  journal.started().saved(file("kept.csv"));
  expect((await journal.wait(0, live(), always)).file.fileName).toBe("kept.csv");
});

it("a running download dropped past the journal's bound fails its wait instead of leaving it waiting", async () => {
  const journal = new DownloadJournal();
  journal.started();
  const waiting = journal.wait(0, live(), always);
  for (let count = 0; count < 40; count++) journal.started();
  await expect(waiting).rejects.toThrow("more than 40 downloads started before a wait took it");
});

it("overlapping saves each settle with the record their own save added, matched by URL", async () => {
  const tab = { downloads: [] as SavedDownload[] };
  const download = (name: string) => ({ url: () => `https://files.test/${name}` });
  const second = Promise.withResolvers<void>();
  const first = journalDownload(tab, download("a.csv"), async () => {
    // The second save lands its record while the first is still running.
    await second.promise;
    tab.downloads.push(file("a.csv"));
  });
  const failing = journalDownload(tab, download("broken.csv"), async () => {
    await second.promise;
  });
  await journalDownload(tab, download("b.csv"), async () => {
    tab.downloads.push(file("b.csv"));
  });
  second.resolve();
  await Promise.all([first, failing]);
  // Entries keep the order the downloads started in: a.csv, broken.csv, b.csv.
  const journal = downloadJournal(tab);
  const a = await journal.wait(0, live(), always);
  expect(a.file.fileName).toBe("a.csv");
  a.claim();
  await expect(journal.wait(0, live(), always)).rejects.toThrow("The download did not save");
  expect((await journal.wait(0, live(), always)).file.fileName).toBe("b.csv");
});
