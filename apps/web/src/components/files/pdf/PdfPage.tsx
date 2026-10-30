import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { TextLayer, RenderTask } from "pdfjs-dist";
import { loadPdfEngine, type PDFDocumentProxy, type PDFPageProxy } from "./pdfEngine";
import { extractPageLinks, type PdfLink } from "./pdfLinks";
import { highlightPdfText, pageText, type PdfMatch } from "./pdfSearch";

/** Mounted only while visible; each render owns its canvas, text layer and cancellation. */
export function PdfPage(props: {
  document: PDFDocumentProxy;
  number: number;
  scale: number;
  width: number;
  height: number;
  matches: readonly PdfMatch[];
  selected: PdfMatch | undefined;
  navigate: (page: number) => void;
  openLink: (
    url: string,
    options?: { readonly event?: { metaKey: boolean; ctrlKey: boolean; button?: number } },
  ) => Promise<void>;
  /** Middle clicks are left to the browser unless the link needs the environment's address. */
  needsEnvironmentRoute: (url: string) => boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<{ text: TextLayer; starts: number[] } | null>(null);
  const [ready, setReady] = useState(0);
  const [links, setLinks] = useState<PdfLink[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    let cancelled = false;
    let page: PDFPageProxy | undefined;
    let render: RenderTask | undefined;
    let text: TextLayer | undefined;
    const canvas = document.createElement("canvas");
    const textHost = document.createElement("div");
    textHost.className = "textLayer";
    host.append(canvas, textHost);
    void (async () => {
      const engine = await loadPdfEngine();
      if (cancelled) return;
      page = await props.document.getPage(props.number);
      if (cancelled) {
        page.cleanup();
        return;
      }
      const viewport = page.getViewport({ scale: props.scale });
      // Bound the bitmap allocation even at high zoom on a Retina screen.
      const outputScale = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(16_777_216 / (viewport.width * viewport.height)),
      );
      canvas.width = Math.ceil(viewport.width * outputScale);
      canvas.height = Math.ceil(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      render = page.render({ canvas, viewport, transform: [outputScale, 0, 0, outputScale, 0, 0] });
      // Observe cancellation immediately, even if text extraction fails first.
      void render.promise.catch(() => undefined);
      const content = await page.getTextContent();
      if (cancelled) return;
      text = new engine.TextLayer({ textContentSource: content, container: textHost, viewport });
      const starts = pageText(content).starts;
      const [pageLinks] = await Promise.all([
        extractPageLinks({ doc: props.document, page, viewport }),
        text.render(),
        render.promise,
      ]);
      if (cancelled) return;
      layer.current = { text, starts };
      setLinks(pageLinks);
      setReady((value) => value + 1);
    })().catch((cause: unknown) => {
      if (!cancelled)
        setError(cause instanceof Error ? cause.message : "Could not render this page.");
    });
    return () => {
      cancelled = true;
      layer.current = null;
      text?.cancel();
      render?.cancel();
      // Release the backing store immediately, including cancelled zoom renders.
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
      textHost.remove();
      if (render) void render.promise.catch(() => undefined).then(() => page?.cleanup());
      else page?.cleanup();
    };
  }, [props.document, props.number, props.scale]);

  useEffect(() => {
    const current = layer.current;
    if (!current) return;
    highlightPdfText(
      current.text.textDivs,
      current.text.textContentItemsStr,
      current.starts,
      props.matches.filter((match) => match.page === props.number - 1),
      props.selected,
    );
    if (props.selected)
      root.current
        ?.querySelector<HTMLElement>('mark[data-selected="true"]')
        ?.scrollIntoView({ block: "center", inline: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A newly rendered text layer needs its highlights applied.
  }, [ready, props.matches, props.selected, props.number]);

  return (
    <div
      data-pdf-page=""
      className="relative bg-white text-black shadow-sm"
      role="group"
      aria-label={`Page ${props.number}`}
      style={
        {
          width: props.width,
          height: props.height,
          "--scale-factor": props.scale,
          "--total-scale-factor": props.scale,
        } as CSSProperties
      }
    >
      <div ref={root} />
      {links.map((link) => (
        <a
          key={link.id}
          className="absolute z-10 hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
          href={link.url ?? `#page=${link.targetPageNumber}`}
          aria-label={link.url ?? `Go to page ${link.targetPageNumber}`}
          onAuxClick={(event) => {
            if (event.button !== 1 || !link.url || !props.needsEnvironmentRoute(link.url)) return;
            event.preventDefault();
            void props
              .openLink(link.url, { event: { metaKey: false, ctrlKey: false, button: 1 } })
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Could not open link."),
              );
          }}
          onClick={(event) => {
            event.preventDefault();
            if (link.targetPageNumber) props.navigate(link.targetPageNumber);
            else if (link.url)
              void props
                .openLink(link.url)
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : "Could not open link."),
                );
          }}
        />
      ))}
      {error ? (
        <p
          role="alert"
          className="absolute inset-x-0 top-0 bg-background p-3 text-xs text-destructive"
        >
          {error} Use Reload PDF to try again.
        </p>
      ) : null}
    </div>
  );
}
