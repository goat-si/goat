import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AssetCreateUrlInput } from "./assets.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// The media-file request as servers before hostOnly decode it (assets.ts at c995c5427a).
const OlderServerMediaFileRequest = Schema.Struct({
  resource: Schema.TaggedStruct("media-file", {
    threadId: ThreadId,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
    disposition: Schema.optionalKey(Schema.Literal("attachment")),
  }),
});

const decodeOlder = Schema.decodeUnknownSync(OlderServerMediaFileRequest);
const decodeNewer = Schema.decodeUnknownSync(AssetCreateUrlInput);

describe("media-file hostOnly across versions", () => {
  const request = {
    resource: { _tag: "media-file", threadId: "thread-1", path: "/repo/logo.png", hostOnly: true },
  };

  it("an older server decodes a newer client's hostOnly request and ignores the flag", () => {
    expect(decodeOlder(request)).toEqual({
      resource: { _tag: "media-file", threadId: "thread-1", path: "/repo/logo.png" },
    });
  });

  it("a newer server keeps the flag, and an older client's request decodes without it", () => {
    expect(decodeNewer(request)).toEqual(request);
    const { hostOnly: _hostOnly, ...older } = request.resource;
    expect(decodeNewer({ resource: older })).toEqual({
      resource: older,
    });
  });

  it("rejects a hostOnly that is not true", () => {
    expect(() =>
      decodeNewer({
        resource: { ...request.resource, hostOnly: false },
      }),
    ).toThrow();
  });
});
