import { EnvironmentId } from "@goat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom, AsyncResult } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";

import { type ComposerImageAttachment } from "../composerDraftStore";

const mocks = vi.hoisted(() => ({
  waitRegistry: vi.fn(),
  connectionStateAtom: vi.fn(),
  createAssetUrl: vi.fn(),
  createUploadUrl: Symbol("create-upload-url"),
  executeAtomQuery: vi.fn(),
  removeUpload: Symbol("remove-upload"),
  runAtomCommand: vi.fn(),
  readEnvironmentScope: vi.fn(),
  readPreparedConnection: vi.fn(),
}));

vi.mock("@goat/client-runtime/state/attachmentUploadRegistry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@goat/client-runtime/state/attachmentUploadRegistry")>();
  return {
    ...actual,
    createAttachmentUploadRegistry: (
      options: Parameters<typeof actual.createAttachmentUploadRegistry>[0],
    ) => {
      const registry = actual.createAttachmentUploadRegistry({ ...options, maxHolders: 1 });
      mocks.waitRegistry.mockImplementation(() => registry.settled());
      return registry;
    },
  };
});

vi.mock("@goat/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});

vi.mock("../connection/catalog", () => ({
  environmentCatalog: { stateAtom: mocks.connectionStateAtom },
}));

vi.mock("../state/assets", () => ({
  assetEnvironment: { createUrl: mocks.createAssetUrl },
}));

vi.mock("../state/attachments", () => ({
  attachmentEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
    remove: mocks.removeUpload,
  },
}));

vi.mock("../state/session", () => ({
  readEnvironmentScope: mocks.readEnvironmentScope,
  readPreparedConnection: mocks.readPreparedConnection,
}));

import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "./attachmentUploadQueue";

type ProgressListener = (event: {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}) => void;

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];

  status = 0;
  timeout = 0;
  method: string | null = null;
  url: string | null = null;
  readonly headers = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  progressListener: ProgressListener | null = null;

  readonly upload = {
    addEventListener: (_event: string, listener: ProgressListener) => {
      this.progressListener = listener;
    },
  };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  send(): void {}

  abort(): void {
    this.listeners.get("abort")?.();
  }

  progress(loaded: number, total: number): void {
    this.progressListener?.({ lengthComputable: true, loaded, total });
  }

  complete(status = 204): void {
    this.status = status;
    this.listeners.get("load")?.();
  }
}

const firstEnvironment = EnvironmentId.make("environment-1");
const secondEnvironment = EnvironmentId.make("environment-2");

function makeImage(id: string): ComposerImageAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

const connectionStates = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(AsyncResult.success({ phase: "connected" })),
);

function setConnected(environmentId: EnvironmentId, connected: boolean) {
  appAtomRegistry.set(
    connectionStates(environmentId),
    AsyncResult.success({ phase: connected ? "connected" : "backoff" }),
  );
}

describe("attachmentUploadQueue", () => {
  beforeEach(() => {
    mocks.connectionStateAtom.mockImplementation(connectionStates);
    setConnected(firstEnvironment, true);
    setConnected(secondEnvironment, true);
    TestXmlHttpRequest.requests = [];
    mocks.createAssetUrl.mockReset();
    mocks.createAssetUrl.mockImplementation((target: unknown) => target);
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success", value: {} });
    mocks.runAtomCommand.mockReset();
    mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
    mocks.readPreparedConnection.mockReset();
    mocks.readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://environment.test/" });
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: { readonly name?: string };
        },
      ) => {
        if (command === mocks.createUploadUrl) {
          const attachmentId = `pending-${target.environmentId}-${target.input.name}`;
          return {
            _tag: "Success",
            value: {
              attachmentId,
              relativeUrl: `/api/attachments/upload/${attachmentId}`,
              expiresAt: 1,
            },
          };
        }
        return { _tag: "Success", value: undefined };
      },
    );
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
  });

  afterEach(() => {
    for (const imageId of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId)) {
      releaseAttachmentUpload(imageId);
    }
    vi.unstubAllGlobals();
  });

  it("cleans up a refused upload and permits retry after capacity returns", async () => {
    const first = makeImage("capacity-first");
    const second = makeImage("capacity-second");
    const subscribe = appAtomRegistry.subscribe.bind(appAtomRegistry);
    const stopped = vi.fn();
    using _subscribe = vi
      .spyOn(appAtomRegistry, "subscribe")
      .mockImplementation((atom, listener) => {
        const stop = subscribe(atom, listener);
        return () => {
          stopped();
          stop();
        };
      });
    startAttachmentUpload({ environmentId: firstEnvironment, image: first });
    await Promise.resolve();
    expect(() =>
      startAttachmentUpload({ environmentId: firstEnvironment, image: second }),
    ).not.toThrow();
    expect(readAttachmentUpload(second.id)).toMatchObject({
      status: "failed",
      environmentId: firstEnvironment,
    });
    await awaitAttachmentUploads([second.id]);
    expect(stopped).toHaveBeenCalledOnce();
    TestXmlHttpRequest.requests[0]?.complete();
    await mocks.waitRegistry();
    retryAttachmentUpload({ environmentId: firstEnvironment, image: second });
    await Promise.resolve();
    const secondSettled = awaitAttachmentUploads([second.id]);
    TestXmlHttpRequest.requests[1]?.complete();
    await secondSettled;
    expect(readAttachmentUpload(second.id)).toMatchObject({
      status: "ready",
      environmentId: firstEnvironment,
    });
  });

  it("settles an already waiting send with the typed admission error", async () => {
    const first = makeImage("capacity-first-waiter");
    const second = makeImage("capacity-second-waiter");
    startAttachmentUpload({ environmentId: firstEnvironment, image: first });
    let waiting: Promise<void> | undefined;
    const unsubscribe = useAttachmentUploadStore.subscribe((state) => {
      if (state.uploadsByImageId[second.id]?.status === "uploading" && waiting === undefined) {
        waiting = awaitAttachmentUploads([second.id]);
      }
    });
    try {
      startAttachmentUpload({ environmentId: firstEnvironment, image: second });
      expect(waiting).toBeDefined();
      await expect(waiting).rejects.toMatchObject({
        _tag: "WebUploadError",
        message: "Upload holder limit reached.",
      });
      expect(readAttachmentUpload(second.id)?.status).toBe("failed");
    } finally {
      unsubscribe();
      releaseAttachmentUpload(first.id);
    }
  });
});
