import * as React from "react";
import * as Schema from "effect/Schema";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@goat/shared/composerContextClipboard";
import { useStableCallback } from "./useStableCallback";

export class ClipboardApiUnavailableError extends Schema.TaggedError<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while copying ${this.target}.`;
  }
}

export class ClipboardWriteError extends Schema.TaggedError<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.target} to the clipboard.`;
  }
}

export class ClipboardReadUnavailableError extends Schema.TaggedError<ClipboardReadUnavailableError>()(
  "ClipboardReadUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while reading ${this.target}.`;
  }
}

export class ClipboardReadError extends Schema.TaggedError<ClipboardReadError>()(
  "ClipboardReadError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.target} from the clipboard.`;
  }
}

function writeTextWithExecCommand(
  value: string,
  extraFlavors?: Readonly<Record<string, string>>,
  requireRich = false,
): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.fontSize = "16px";

  const previouslyFocused = document.activeElement;
  let wroteFlavors = false;
  const copy = (event: ClipboardEvent) => {
    if (!extraFlavors || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", value);
    for (const [type, data] of Object.entries(extraFlavors))
      event.clipboardData.setData(type, data);
    wroteFlavors = true;
    event.preventDefault();
  };
  document.body.appendChild(textarea);
  textarea.addEventListener("copy", copy);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy") && (!requireRich || wroteFlavors);
  } catch {
    return false;
  } finally {
    textarea.removeEventListener("copy", copy);
    textarea.remove();
    const restoreFocus = (previouslyFocused as { focus?: unknown } | null)?.focus;
    if (typeof restoreFocus === "function") {
      restoreFocus.call(previouslyFocused);
    }
  }
}

export async function writeTextToClipboard(
  value: string,
  target = "text",
  extraFlavors?: Readonly<Record<string, string>>,
  required: boolean | { requireHtml?: boolean } = false,
) {
  const requireRich = typeof required === "boolean" ? required : required.requireHtml === true;
  if (typeof window === "undefined") {
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  if (!value) return false;
  if (extraFlavors) {
    extraFlavors = Object.fromEntries(
      Object.entries(extraFlavors).filter(([type]) => type !== "text/plain"),
    );
  }
  const contextFragment = extraFlavors?.[COMPOSER_CONTEXT_CLIPBOARD_MIME];
  if (contextFragment)
    extraFlavors = {
      ...extraFlavors,
      "text/html": encodeComposerContextClipboardHtml(
        value,
        contextFragment,
        extraFlavors?.["text/html"],
      ),
    };

  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    if (writeTextWithExecCommand(value, extraFlavors, requireRich)) return true;
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  try {
    if (extraFlavors && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([value], { type: "text/plain" }),
            ...Object.fromEntries(
              Object.entries(extraFlavors).map(([type, data]) => [
                type,
                new Blob([data], { type }),
              ]),
            ),
          }),
        ]);
        return true;
      } catch {
        // Safari/native bridges may accept HTML but reject Chromium's custom web flavor.
        const html = extraFlavors["text/html"];
        if (html) {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/plain": new Blob([value], { type: "text/plain" }),
                "text/html": new Blob([html], { type: "text/html" }),
              }),
            ]);
            return true;
          } catch {}
        }
      }
    }
    if (requireRich) throw new Error("The clipboard cannot preserve thread context.");
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    if (writeTextWithExecCommand(value, extraFlavors, requireRich)) return true;
    throw new ClipboardWriteError({
      target,
      cause,
    });
  }
}

/** Takes a factory so the write starts inside the click while the PNG is still being made. */
export async function writePngToClipboard(
  png: () => Promise<Blob>,
  target = "image",
): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new ClipboardApiUnavailableError({ target });
  }
  try {
    const image = png();
    // The clipboard can refuse before it reads the image; its rejection then reports the copy.
    void image.catch(() => undefined);
    // Safari rejects a clipboard write that starts after an await, so hand it the promise.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
    return true;
  } catch (cause) {
    throw new ClipboardWriteError({ target, cause });
  }
}

export async function readTextFromClipboard(target = "text"): Promise<string> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.readText
  ) {
    throw new ClipboardReadUnavailableError({
      target,
    });
  }

  try {
    return await navigator.clipboard.readText();
  } catch (cause) {
    throw new ClipboardReadError({
      target,
      cause,
    });
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
  extraFlavors,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
  extraFlavors?: Readonly<Record<string, string>>;
} = {}): {
  copyToClipboard: (
    value: string,
    ctx: TContext,
    flavors?: Readonly<Record<string, string>>,
    options?: { requireHtml?: boolean },
  ) => void;
  copyPngToClipboard: (png: () => Promise<Blob>, ctx: TContext) => void;
  isCopied: boolean;
} {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const settleCopy = (write: Promise<boolean>, ctx: TContext): void => {
    void write.then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopy?.(ctx);

        if (timeout !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeout);
        }
      },
      (error) => {
        console.error(error);
        onError?.(error, ctx);
      },
    );
  };
  const copyToClipboard = useStableCallback(
    (
      value: string,
      ctx: TContext,
      flavors: Readonly<Record<string, string>> | undefined = extraFlavors,
      options?: { requireHtml?: boolean },
    ): void => {
      settleCopy(writeTextToClipboard(value, target, flavors, options), ctx);
    },
  );
  const copyPngToClipboard = useStableCallback((png: () => Promise<Blob>, ctx: TContext): void => {
    settleCopy(writePngToClipboard(png, target), ctx);
  });

  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, copyPngToClipboard, isCopied };
}
