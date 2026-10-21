import { describe, expect, it } from "@effect/vitest";

import {
  classifyRemoteTransportFailure,
  remoteDeadlineMessage,
  remoteUnavailableMessage,
} from "./remoteFailureCopy.ts";

const fetchFailed = (cause?: unknown) =>
  new Error("fetch failed", cause === undefined ? undefined : { cause });
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("classifyRemoteTransportFailure", () => {
  it("reads the reason Node's fetch keeps in the cause chain", () => {
    expect(classifyRemoteTransportFailure(fetchFailed(coded("ECONNREFUSED")))).toBe("refused");
    expect(classifyRemoteTransportFailure(fetchFailed(coded("UND_ERR_HEADERS_TIMEOUT")))).toBe(
      "timeout",
    );
    expect(classifyRemoteTransportFailure(fetchFailed(coded("UND_ERR_SOCKET")))).toBe("dropped");
    expect(classifyRemoteTransportFailure(fetchFailed(coded("ENOTFOUND")))).toBe("unreachable");
    // A wrapper around the fetch error, as the MCP bridge adds.
    expect(
      classifyRemoteTransportFailure(
        new Error("bridge", { cause: fetchFailed(coded("ECONNRESET")) }),
      ),
    ).toBe("dropped");
  });

  it("treats an aborted request as a timeout", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(classifyRemoteTransportFailure(abort)).toBe("timeout");
  });

  it("knows nothing about an error without a transport cause", () => {
    expect(classifyRemoteTransportFailure(fetchFailed())).toBeNull();
    expect(classifyRemoteTransportFailure("boom")).toBeNull();
  });
});

describe("remoteUnavailableMessage", () => {
  it("never repeats the bare fetch failure", () => {
    for (const error of [
      fetchFailed(),
      fetchFailed(coded("ECONNREFUSED")),
      fetchFailed(coded("ETIMEDOUT")),
    ]) {
      expect(remoteUnavailableMessage("mac-studio", error)).not.toContain("fetch failed");
    }
  });

  it("names the host, what happened and where to look", () => {
    expect(
      remoteUnavailableMessage("mac-studio", fetchFailed(coded("UND_ERR_HEADERS_TIMEOUT"))),
    ).toBe(
      "GOAT on mac-studio is too busy to answer: the request timed out. A stalled server is usually overloaded or has a large database; Fleet shows its load and storage.",
    );
    expect(remoteDeadlineMessage("mac-studio", "goat_host_status", 10_000)).toContain(
      "did not answer goat_host_status within 10s",
    );
  });

  it("keeps an unrecognized error's own words", () => {
    expect(remoteUnavailableMessage("lidge", new Error("certificate has expired"))).toBe(
      "GOAT on lidge did not answer: certificate has expired",
    );
  });
});
