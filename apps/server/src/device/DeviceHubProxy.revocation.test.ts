import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AuthOrchestrationReadScope, AuthSessionId, LOCAL_DEVICE_HOST_ID } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionLifetime from "../auth/SessionSocketLifetime.testkit.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHubProxy from "./DeviceHubProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (closeGate?: Promise<void>) => {
  let revoke = () => {};
  const revoked = new Promise<void>((resolve) => {
    revoke = resolve;
  });
  const requests: Array<{ readonly method: string; readonly url: string; readonly body: string }> =
    [];
  const client = HttpClient.make((request) =>
    Effect.promise(async () => {
      if (
        closeGate &&
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/webrtc/close")
      )
        await closeGate;
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ method: request.method, url: request.url, body });
      // serve-sim only accepts POST signalling.
      if (request.method !== "POST" && new URL(request.url).pathname.endsWith("/webrtc/close"))
        return HttpClientResponse.fromWeb(request, new Response("", { status: 405 }));
      // A live MJPEG-like stream: one frame, then it stays open.
      const stream = request.url.endsWith("/stream.mjpeg")
        ? new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new TextEncoder().encode("frame")),
          })
        : "{}";
      return HttpClientResponse.fromWeb(request, new Response(stream));
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    DeviceHubProxy.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes: [AuthOrchestrationReadScope],
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(DeviceService.DeviceService, {
          currentReadiness: () =>
            Effect.succeed({ hostId: LOCAL_DEVICE_HOST_ID, hub: { origin: "http://hub.test" } }),
        } as DeviceService.DeviceService["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(SessionLifetime.layerRevocable(revoked)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, revoke };
};

const signal = (path: string, sessionId: string, method = "POST", device = "sim-1") =>
  new Request(`http://t3.test/api/device-hub/vendor/serve-sim/helper/${device}/webrtc/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: path, sessionId }),
  });
const upstreamCloses = (
  requests: ReadonlyArray<{ readonly method: string; readonly url: string; readonly body: string }>,
) =>
  requests
    .filter(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname.endsWith("/webrtc/close"),
    )
    .map((request) => [request.url, JSON.parse(request.body).sessionId]);

const androidSignal = (path: string, device: string) =>
  new Request(`http://t3.test/api/device-hub/vendor/serve-emu/webrtc/${path}?device=${device}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "peer-1" }),
  });

describe("device hub proxy revocation", () => {
  it("ends a live device stream when its session loses authority", async () => {
    const { handler, revoke } = fixture();
    const response = await handler(
      new Request("http://t3.test/api/device-hub/vendor/serve-sim/helper/sim-1/stream.mjpeg"),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("frame");
    revoke();
    expect((await reader.read()).done).toBe(true);
  });

  it("closes an established WebRTC peer upstream when its session loses authority", async () => {
    const { handler, requests, revoke } = fixture();
    expect((await handler(signal("offer", "peer-1"))).status).toBe(200);
    revoke();
    await vi.waitFor(() =>
      expect(upstreamCloses(requests)).toEqual([
        ["http://hub.test/vendor/serve-sim/helper/sim-1/webrtc/close", "peer-1"],
      ]),
    );
  });

  it("stops watching a WebRTC peer only after the client's close succeeds", async () => {
    const { handler, requests, revoke } = fixture();
    await (await handler(signal("offer", "peer-1"))).text();
    expect((await handler(signal("close", "peer-1", "PUT"))).status).toBe(405);
    await (await handler(signal("offer", "peer-2"))).text();
    await (await handler(signal("close", "peer-2"))).text();
    revoke();
    await vi.waitFor(() =>
      expect(upstreamCloses(requests)).toEqual([
        ["http://hub.test/vendor/serve-sim/helper/sim-1/webrtc/close", "peer-2"],
        ["http://hub.test/vendor/serve-sim/helper/sim-1/webrtc/close", "peer-1"],
      ]),
    );
  });

  it("closes peers with the same id on every helper that accepted them", async () => {
    const { handler, requests, revoke } = fixture();
    await (await handler(signal("offer", "peer-1", "POST", "sim-1"))).text();
    await (await handler(signal("offer", "peer-1", "POST", "sim-2"))).text();
    revoke();
    await vi.waitFor(() =>
      expect(upstreamCloses(requests).toSorted()).toEqual([
        ["http://hub.test/vendor/serve-sim/helper/sim-1/webrtc/close", "peer-1"],
        ["http://hub.test/vendor/serve-sim/helper/sim-2/webrtc/close", "peer-1"],
      ]),
    );
  });

  it("closes same-id peers on both Android devices when their shared session is revoked", async () => {
    const { handler, requests, revoke } = fixture();
    await (await handler(androidSignal("offer", "emulator-5554"))).text();
    await (await handler(androidSignal("offer", "emulator-5556"))).text();
    revoke();
    await vi.waitFor(() =>
      expect(upstreamCloses(requests).toSorted()).toEqual([
        ["http://hub.test/vendor/serve-emu/webrtc/close?device=emulator-5554", "peer-1"],
        ["http://hub.test/vendor/serve-emu/webrtc/close?device=emulator-5556", "peer-1"],
      ]),
    );
  });

  it("closing one Android device's peer leaves the other device's revocation watch active", async () => {
    const { handler, requests, revoke } = fixture();
    await (await handler(androidSignal("offer", "emulator-5554"))).text();
    await (await handler(androidSignal("offer", "emulator-5556"))).text();
    await (await handler(androidSignal("close", "emulator-5554"))).text();
    revoke();
    await vi.waitFor(() =>
      expect(upstreamCloses(requests)).toEqual([
        ["http://hub.test/vendor/serve-emu/webrtc/close?device=emulator-5554", "peer-1"],
        ["http://hub.test/vendor/serve-emu/webrtc/close?device=emulator-5556", "peer-1"],
      ]),
    );
  });

  it("refuses a 17th open peer per session until one closes", async () => {
    const { handler, requests } = fixture();
    for (let index = 0; index < 16; index++) {
      expect((await handler(signal("offer", `peer-${index}`))).status).toBe(200);
    }
    const sent = requests.length;
    expect((await handler(signal("offer", "peer-16"))).status).toBe(429);
    expect(requests).toHaveLength(sent);
    await (await handler(signal("close", "peer-0"))).text();
    expect((await handler(signal("offer", "peer-16"))).status).toBe(200);
  });

  it("keeps a newer offer's watch when the previous close answers late", async () => {
    let answerClose = () => {};
    const gate = new Promise<void>((resolve) => {
      answerClose = resolve;
    });
    const { handler, requests, revoke } = fixture(gate);
    await (await handler(signal("offer", "peer-1"))).text();
    const closing = handler(signal("close", "peer-1"));
    const reopening = handler(signal("offer", "peer-1"));
    answerClose();
    await (await closing).text();
    expect((await reopening).status).toBe(200);
    revoke();
    await vi.waitFor(() =>
      expect(upstreamCloses(requests)).toEqual([
        ["http://hub.test/vendor/serve-sim/helper/sim-1/webrtc/close", "peer-1"],
        ["http://hub.test/vendor/serve-sim/helper/sim-1/webrtc/close", "peer-1"],
      ]),
    );
  });

  it("refuses an oversized signalling body before it reaches the helper", async () => {
    const { handler, requests } = fixture();
    const response = await handler(
      new Request("http://t3.test/api/device-hub/vendor/serve-sim/helper/sim-1/webrtc/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(70 * 1024),
      }),
    );
    expect(response.status).toBe(413);
    expect(requests).toEqual([]);
  });
});
