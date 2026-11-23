import { act, render, stubGlobal } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import OfficeViewer from "./OpenXmlOfficeViewer";
import { OFFICE_PREVIEW_MAX_BYTES } from "./officePreviewProtocol";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./office/loadWordDocument", () => ({ loadWordDocument: load }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  load.mockReset();
  const response = deferred<Response>();
  const module = deferred<{ default: () => React.ReactNode }>();
  load.mockReturnValue(module.promise);
  const terminate = vi.fn();
  const postMessage = vi.fn();
  class FakeWorker extends EventTarget {
    terminate = terminate;
    postMessage = postMessage;
  }
  return { response, module, terminate, postMessage, FakeWorker };
}

it("starts the Word viewer after response validation while the body is still loading (#3859)", async () => {
  const f = setup();
  using _fetch = stubGlobal("fetch", () => f.response.promise);
  using _worker = stubGlobal("Worker", f.FakeWorker);
  const body = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await body.promise;
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  await using _screen = await render(<OfficeViewer src="/a.docx" name="a.docx" kind="docx" />);
  expect(load).not.toHaveBeenCalled();
  await act(async () => f.response.resolve(new Response(stream)));
  expect(load).toHaveBeenCalledOnce();
  expect(f.postMessage).not.toHaveBeenCalled();
  await act(async () => {
    body.resolve();
    await body.promise;
  });
  await vi.waitFor(() => expect(f.postMessage).toHaveBeenCalledOnce());
});

it.each([
  ["bad status", new Response(null, { status: 403 })],
  [
    "oversized header",
    new Response(null, { headers: { "content-length": String(OFFICE_PREVIEW_MAX_BYTES + 1) } }),
  ],
])("does not load the Word viewer for a rejected %s (#3859)", async (_case, response) => {
  const f = setup();
  using _fetch = stubGlobal("fetch", () => f.response.promise);
  using _worker = stubGlobal("Worker", f.FakeWorker);
  await using screen = await render(<OfficeViewer src="/a.docx" name="a.docx" kind="docx" />);
  await act(async () => f.response.resolve(response));
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(load).not.toHaveBeenCalled();
  expect(f.terminate).toHaveBeenCalled();
});

it("cleans up a failed viewer import without rendering a document", async () => {
  const f = setup();
  using _fetch = stubGlobal("fetch", () => f.response.promise);
  using _worker = stubGlobal("Worker", f.FakeWorker);
  await using screen = await render(<OfficeViewer src="/a.docx" name="a.docx" kind="docx" />);
  await act(async () => f.response.resolve(new Response(new ReadableStream())));
  await act(async () => f.module.reject(new Error("viewer failed")));
  await expect
    .element(screen.getByText("viewer failed Save it or open it in another app."))
    .toBeVisible();
  expect(f.terminate).toHaveBeenCalled();
  expect(f.postMessage).not.toHaveBeenCalled();
});

it("ignores a viewer import that finishes after unmount", async () => {
  const f = setup();
  using _fetch = stubGlobal("fetch", () => f.response.promise);
  using _worker = stubGlobal("Worker", f.FakeWorker);
  await using screen = await render(<OfficeViewer src="/a.docx" name="a.docx" kind="docx" />);
  await act(async () => f.response.resolve(new Response(new ReadableStream())));
  await screen.unmount();
  await act(async () => f.module.resolve({ default: () => <p>stale document</p> }));
  expect(screen.container.textContent).not.toContain("stale document");
  expect(f.terminate).toHaveBeenCalled();
  expect(f.postMessage).not.toHaveBeenCalled();
});
