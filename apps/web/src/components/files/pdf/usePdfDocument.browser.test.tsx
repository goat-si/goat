import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PDFDocumentProxy } from "./pdfEngine";
import { usePdfDocument } from "./usePdfDocument";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./pdfEngine", () => ({ loadPdfDocument: load }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function pdf() {
  const destroy = vi.fn(async () => {});
  return {
    document: {
      numPages: 3,
      loadingTask: { destroy },
      getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }) }),
    } as unknown as PDFDocumentProxy,
    destroy,
  };
}

describe("PDF resource generations (Synara lifecycle cases)", () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  const render = (url: string) => root!.render(<Harness url={url} />);
  const observations: (PDFDocumentProxy | null)[] = [];
  function Harness({ url }: { url: string }) {
    const state = usePdfDocument(url);
    useLayoutEffect(() => {
      observations.push(state.document);
    });
    return (
      <output>
        {state.status}:{state.error}
      </output>
    );
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    observations.length = 0;
    load.mockReset();
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root?.unmount());
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
  });
  it("never publishes the destroyed first A during A -> B -> A", async () => {
    const a = pdf();
    const secondA = pdf();
    const requests: ReturnType<typeof deferred<Response>>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const request = deferred<Response>();
        requests.push(request);
        return request.promise;
      }),
    );
    load.mockResolvedValueOnce(a.document).mockResolvedValueOnce(secondA.document);
    await act(async () => {
      render("/a.pdf");
    });
    await act(async () => {
      requests[0]!.resolve(new Response(new Uint8Array([1])));
    });
    expect(observations.at(-1)).toBe(a.document);
    await act(() => render("/b.pdf"));
    expect(a.destroy).toHaveBeenCalledOnce();
    const beforeReturn = observations.length;
    await act(() => render("/a.pdf"));
    expect(observations.slice(beforeReturn)).not.toContain(a.document);
    expect(observations.at(-1)).toBeNull();
    await act(async () => {
      requests[2]!.resolve(new Response(new Uint8Array([2])));
    });
    expect(observations.at(-1)).toBe(secondA.document);
    await act(async () => {
      requests[1]!.resolve(new Response(new Uint8Array([3])));
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(observations.at(-1)).toBe(secondA.document);
  });
  it("destroys an obsolete document that finishes loading after switching", async () => {
    const old = pdf();
    const pending = deferred<PDFDocumentProxy>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]))),
    );
    load.mockReturnValueOnce(pending.promise).mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      render("/a.pdf");
    });
    // A must be loading before the switch for its late result to be obsolete.
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await act(() => render("/b.pdf"));
    await act(async () => {
      pending.resolve(old.document);
    });
    await vi.waitFor(() => expect(old.destroy).toHaveBeenCalledOnce());
    expect(observations).not.toContain(old.document);
  });
  it("propagates read failures and loads fresh bytes for a renewed URL", async () => {
    const good = pdf();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetchMock);
    load.mockResolvedValue(good.document);
    await act(async () => {
      render("https://remote.test/expired");
    });
    await vi.waitFor(() =>
      expect(container.querySelector("output")!.textContent).toContain(
        "error:Failed to load PDF (403)",
      ),
    );
    await act(async () => {
      render("https://remote.test/renewed");
    });
    await vi.waitFor(() => expect(observations.at(-1)).toBe(good.document));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://remote.test/expired",
      "https://remote.test/renewed",
    ]);
    expect(fetchMock.mock.calls[0]![1].cache).toBe("no-store");
  });
  it("destroys a document if reading the first page fails", async () => {
    const broken = pdf();
    broken.document.getPage = vi.fn().mockRejectedValue(new Error("Broken page"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]))),
    );
    load.mockResolvedValue(broken.document);
    await act(async () => {
      render("/broken.pdf");
    });
    await vi.waitFor(() => expect(broken.destroy).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(container.querySelector("output")!.textContent).toContain("Broken page"),
    );
  });
});
