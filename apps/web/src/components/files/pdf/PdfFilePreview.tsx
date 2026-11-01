import type { ScopedThreadRef } from "@goat/contracts";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { urlNeedsEnvironmentRoute } from "~/browser/openEnvironmentUrl";
import { useOpenLink } from "~/browser/useOpenLink";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "~/components/solar";
import { Input } from "~/components/ui/input";
import { observeResize } from "~/lib/observeResize";
import { FileSurfaceFailure, FileSurfaceLoading } from "../fileSurfaceChrome";
import type { PDFDocumentProxy } from "./pdfEngine";
import {
  clampScale,
  layoutPages,
  pageAtOffset,
  visiblePages,
  type PdfSize,
  type PdfZoom,
} from "./pdfLayout";
import { findPdfMatches, indexPdfText } from "./pdfSearch";
import { usePdfDocument } from "./usePdfDocument";
import { PdfPage } from "./PdfPage";
import { PdfIconButton, PdfToolbar } from "./PdfToolbar";
import { isPdfFindShortcut } from "./pdfShortcuts";
import { initialPdfView, type PdfViewState, type PdfReadingPosition } from "./usePdfViewState";
import "./pdfViewer.css";

interface PdfFilePreviewProps {
  src: string;
  title: string;
  onRetry?: (() => Promise<string | null>) | undefined;
  threadRef?: ScopedThreadRef | undefined;
  revision?: string | undefined;
  viewState?: PdfReadingPosition | undefined;
}

export default function PdfFilePreview(props: PdfFilePreviewProps) {
  const [view, setView] = useState(initialPdfView);
  const position = props.viewState ?? { view, onViewChange: setView };
  return (
    <PdfResource
      key={props.revision ?? props.src}
      {...props}
      initialView={position.view}
      onViewChange={position.onViewChange}
    />
  );
}

interface PdfViewProps {
  initialView: PdfViewState;
  onViewChange: (view: PdfViewState) => void;
}

function PdfResource(props: PdfFilePreviewProps & PdfViewProps) {
  const [resource, setResource] = useState({ url: props.src, revision: 0 });
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = () => {
    setRetrying(true);
    setError(null);
    void (async () => {
      const url = props.onRetry ? await props.onRetry() : resource.url;
      if (!url) throw new Error("Reconnect to the environment and try again.");
      setResource((previous) => ({ url, revision: previous.revision + 1 }));
    })()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not reload this PDF.");
      })
      .finally(() => setRetrying(false));
  };
  if (retrying) return <FileSurfaceLoading />;
  if (error) return <FileSurfaceFailure message={error} onRetry={retry} />;
  return (
    <PdfSession
      key={resource.revision}
      url={resource.url}
      title={props.title}
      retry={retry}
      threadRef={props.threadRef}
      initialView={props.initialView}
      onViewChange={props.onViewChange}
    />
  );
}

function PdfSession(props: {
  url: string;
  title: string;
  retry: () => void;
  threadRef: ScopedThreadRef | undefined;
  initialView: PdfViewState;
  onViewChange: (view: PdfViewState) => void;
}) {
  const pdf = usePdfDocument(props.url);
  if (pdf.status === "error")
    return (
      <FileSurfaceFailure message={pdf.error ?? "Could not open this PDF."} onRetry={props.retry} />
    );
  if (!pdf.document) return <FileSurfaceLoading />;
  return (
    <PdfDocument
      document={pdf.document}
      title={props.title}
      retry={props.retry}
      threadRef={props.threadRef}
      initialView={props.initialView}
      onViewChange={props.onViewChange}
    />
  );
}

function PdfDocument(props: {
  document: PDFDocumentProxy;
  title: string;
  retry: () => void;
  threadRef: ScopedThreadRef | undefined;
  initialView: PdfViewState;
  onViewChange: (view: PdfViewState) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef(props.initialView.anchor);
  const left = useRef(props.initialView.left);
  const openLink = useOpenLink(props.threadRef);
  const [sizes, setSizes] = useState<PdfSize[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });
  const [top, setTop] = useState(0);
  const [zoom, setZoom] = useState<PdfZoom>(props.initialView.zoom);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [texts, setTexts] = useState<string[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [matchIndex, setMatchIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const dimensions: PdfSize[] = [];
      for (let number = 1; number <= props.document.numPages; number++) {
        if (cancelled) return;
        const page = await props.document.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        dimensions.push({ width: viewport.width, height: viewport.height });
      }
      if (!cancelled) setSizes(dimensions);
    })().catch((cause: unknown) => {
      if (!cancelled)
        setError(cause instanceof Error ? cause.message : "Could not read PDF pages.");
    });
    return () => {
      cancelled = true;
    };
  }, [props.document]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    return observeResize(element, () =>
      setContainer({ width: element.clientWidth, height: element.clientHeight }),
    );
  }, []);

  const pages = layoutPages(sizes, container, zoom);
  const current = pages.length ? pageAtOffset(pages, top + 16) : 0;
  const scale = pages[current]?.scale ?? 1;
  const visible = container.width > 0 ? visiblePages(pages, top, container.height) : [];
  const height = pages.length
    ? pages[pages.length - 1]!.top + pages[pages.length - 1]!.height + 16
    : 0;
  const width = pages.reduce((max, page) => Math.max(max, page.width + 32), container.width);

  // Preserve the logical page and its vertical offset across zoom and resize.
  useLayoutEffect(() => {
    const page = pages[Math.min(anchor.current.page, pages.length - 1)];
    if (!scroll.current || !page) return;
    const nextTop = Math.max(0, page.top - 16 + anchor.current.fraction * page.height);
    scroll.current.scrollTop = nextTop;
    scroll.current.scrollLeft = left.current;
    setTop(nextTop);
  }, [pages]);

  const navigate = (number: number) => {
    const index = Math.max(0, Math.min(pages.length - 1, number - 1));
    const page = pages[index];
    if (!page || !scroll.current) return;
    anchor.current = { page: index, fraction: 0 };
    props.onViewChange({ anchor: anchor.current, zoom, left: left.current });
    const nextTop = Math.max(0, page.top - 16);
    scroll.current.scrollTop = nextTop;
    setTop(nextTop);
  };

  useEffect(() => {
    if (!findOpen || texts || searchError) return;
    const controller = new AbortController();
    void indexPdfText(props.document, controller.signal)
      .then((pages) => {
        if (!controller.signal.aborted) setTexts(pages);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setSearchError(cause instanceof Error ? cause.message : "Could not search this PDF.");
      });
    return () => controller.abort();
  }, [findOpen, props.document, texts, searchError]);

  const matches = findOpen && texts ? findPdfMatches(texts, query) : [];
  const selected = matches[matchIndex];
  const revealMatch = useEffectEvent((number: number) => navigate(number));
  useLayoutEffect(() => {
    if (selected) revealMatch(selected.page + 1);
    // Navigate before PdfPage's passive effect reveals the selected occurrence.
    // Navigating is driven by the selected match, not subsequent manual scrolling.
  }, [selected]);
  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);

  const nextMatch = (direction: number) => {
    if (!matches.length) return;
    const next = (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(next);
  };
  const showFind = () => {
    setFindOpen(true);
    findInput.current?.focus();
    findInput.current?.select();
  };

  if (error) return <FileSurfaceFailure message={error} onRetry={props.retry} />;
  return (
    <div
      ref={root}
      data-pdf-viewer=""
      role="region"
      aria-label={`${props.title} PDF viewer`}
      tabIndex={0}
      className="flex min-h-0 min-w-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onKeyDownCapture={(event) => {
        if (isPdfFindShortcut(event)) {
          event.preventDefault();
          event.stopPropagation();
          showFind();
        } else if (event.key === "Escape" && findOpen) {
          event.preventDefault();
          event.stopPropagation();
          setFindOpen(false);
          root.current?.focus();
        } else if (!(event.target instanceof HTMLInputElement)) {
          const page =
            event.key === "PageDown"
              ? current + 2
              : event.key === "PageUp"
                ? current
                : event.key === "Home"
                  ? 1
                  : event.key === "End"
                    ? pages.length
                    : null;
          if (page !== null) {
            event.preventDefault();
            navigate(page);
          }
        }
      }}
    >
      <PdfToolbar
        page={current + 1}
        count={pages.length}
        scale={scale}
        navigate={navigate}
        zoom={(value) => {
          const next = typeof value === "number" ? clampScale(value) : value;
          props.onViewChange({ anchor: anchor.current, zoom: next, left: left.current });
          setZoom(next);
        }}
        find={showFind}
        reload={props.retry}
      />
      {findOpen ? (
        <div
          role="search"
          aria-label="Find in PDF"
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-xs"
        >
          <div className="min-w-24 flex-1">
            <Input
              ref={findInput}
              size="compact"
              aria-label="Find in PDF"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  nextMatch(event.shiftKey ? -1 : 1);
                }
              }}
            />
          </div>
          <span role="status" className="min-w-0 text-muted-foreground">
            {searchError ??
              (!texts ? (
                "Searching…"
              ) : (
                <span className="whitespace-nowrap tabular-nums">
                  {matches.length ? matchIndex + 1 : 0} of {matches.length}
                  <span className="sr-only"> matches</span>
                </span>
              ))}
          </span>
          <PdfIconButton
            label="Previous match"
            disabled={!matches.length}
            onClick={() => nextMatch(-1)}
          >
            <ChevronLeftIcon />
          </PdfIconButton>
          <PdfIconButton label="Next match" disabled={!matches.length} onClick={() => nextMatch(1)}>
            <ChevronRightIcon />
          </PdfIconButton>
          <PdfIconButton
            label="Close find"
            onClick={() => {
              setFindOpen(false);
              root.current?.focus();
            }}
          >
            <XIcon />
          </PdfIconButton>
        </div>
      ) : null}
      <div
        ref={scroll}
        className="scrollbar-gutter-both relative min-h-0 flex-1 overflow-auto bg-muted"
        onScroll={(event) => {
          const nextTop = event.currentTarget.scrollTop;
          const index = pageAtOffset(pages, nextTop + 16);
          const page = pages[index];
          if (page)
            anchor.current = {
              page: index,
              fraction: Math.max(0, (nextTop - page.top + 16) / page.height),
            };
          left.current = event.currentTarget.scrollLeft;
          props.onViewChange({ anchor: anchor.current, zoom, left: left.current });
          setTop(nextTop);
        }}
      >
        {!pages.length ? (
          <p role="status" className="p-4 text-xs text-muted-foreground">
            Loading PDF pages…
          </p>
        ) : null}
        <div className="relative" style={{ width, height }}>
          {visible.map((page) => (
            <div
              key={page.index}
              className="absolute"
              style={{ top: page.top, left: (width - page.width) / 2 }}
            >
              <PdfPage
                key={page.scale}
                document={props.document}
                number={page.index + 1}
                scale={page.scale}
                width={page.width}
                height={page.height}
                matches={matches}
                selected={selected?.page === page.index ? selected : undefined}
                navigate={navigate}
                openLink={openLink}
                needsEnvironmentRoute={(url) =>
                  urlNeedsEnvironmentRoute(props.threadRef?.environmentId ?? null, url)
                }
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
