import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { RESOLVE_IMAGES_BATCH, type NoteEditorOutbound } from "./note-editor-protocol";

/** Rebuilds the live preview's images; dispatched when URLs arrive or an image stops loading. */
export const imagesChanged = StateEffect.define<null>();

// Past this many distinct images a note shows the rest as their labels.
const MAX_IMAGES = 200;

type ResolveImages = Extract<NoteEditorOutbound, { type: "resolveImages" }>;

/**
 * The page's side of attachment images: which hrefs it asked the app to sign, the URLs it got,
 * and the ones that will never load. An href asks once; an image that stops loading (usually an
 * expired URL) asks once more, and a second failure in a row shows its label until the app sends
 * a different URL, which it does after minting one.
 */
export function createNoteImageStore(
  post: (message: ResolveImages) => void,
  schedule: (run: () => void) => void = queueMicrotask,
) {
  const urls = new Map<string, string>();
  const asked = new Set<string>();
  const missing = new Set<string>();
  const renewed = new Set<string>();
  // The URL each href last failed with, so only a different one restores the renewal.
  const lastFailed = new Map<string, string>();
  let queue: string[] = [];
  const flush = () => {
    const hrefs = queue;
    queue = [];
    for (let index = 0; index < hrefs.length; index += RESOLVE_IMAGES_BATCH)
      post({
        type: "resolveImages",
        hrefs: hrefs.slice(index, index + RESOLVE_IMAGES_BATCH),
        renew: false,
      });
  };
  return {
    /** The URL to show for an href, asking for one the first time it is seen. */
    url(href: string): string | null {
      const known = urls.get(href);
      if (known !== undefined) return known;
      if (asked.has(href) || missing.has(href) || asked.size >= MAX_IMAGES) return null;
      asked.add(href);
      if (queue.push(href) === 1) schedule(flush);
      return null;
    },
    /** Takes the app's answer; true when anything shown changes. */
    receive(resolved: Readonly<Record<string, string>>, gone: ReadonlyArray<string>): boolean {
      let changed = false;
      for (const [href, url] of Object.entries(resolved))
        if (asked.has(href) && urls.get(href) !== url) {
          urls.set(href, url);
          if (lastFailed.get(href) !== url) renewed.delete(href);
          changed = true;
        }
      for (const href of gone)
        if (asked.has(href) && !missing.has(href)) {
          missing.add(href);
          urls.delete(href);
          changed = true;
        }
      return changed;
    },
    loaded(href: string) {
      renewed.delete(href);
    },
    /** An image stopped loading; true when its label should replace it now. */
    failed(href: string): boolean {
      const url = urls.get(href);
      if (url === undefined) return false;
      urls.delete(href);
      lastFailed.set(href, url);
      if (!renewed.has(href)) {
        renewed.add(href);
        post({ type: "resolveImages", hrefs: [href], renew: true });
      }
      return true;
    },
  };
}

export type NoteImageStore = ReturnType<typeof createNoteImageStore>;

/**
 * Rebuilding decorations mid-composition can break Hangul input, so the preview defers image
 * changes; once composition ends this asks again after CodeMirror has settled.
 */
export const imagesAfterComposition = EditorView.domEventHandlers({
  compositionend(_event, view) {
    setTimeout(() => {
      if (!view.composing) view.dispatch({ effects: imagesChanged.of(null) });
    });
    return false;
  },
});
