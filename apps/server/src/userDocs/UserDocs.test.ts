import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as UserDocs from "./UserDocs.ts";
import { parseUserGuide } from "./userGuides.ts";

const guides = UserDocs.layer.pipe(Layer.provide(NodeServices.layer));
const docs = UserDocs.UserDocs;

it.effect("lists every guide in the repository with its title", () =>
  Effect.gen(function* () {
    const { guides: index } = yield* (yield* docs).index;
    expect(index.length).toBeGreaterThan(40);
    expect(index.find((guide) => guide.page === "remote-access")).toEqual({
      page: "remote-access",
      title: "Remote access",
      url: "https://trygoat.ai/docs/user/remote-access/",
    });
  }).pipe(Effect.provide(guides)),
);

it.effect("ranks the section whose heading holds the words first", () =>
  Effect.gen(function* () {
    const found = yield* (yield* docs).search({ query: "how do I use tailscale https", limit: 2 });
    expect(found.words).toEqual(["use", "tailscale", "https"]);
    expect(found.matches[0]).toMatchObject({
      page: "remote-access",
      heading: "Tailscale HTTPS",
      url: "https://trygoat.ai/docs/user/remote-access/#tailscale-https",
    });
    expect(found.matches).toHaveLength(2);
    expect(found.truncated).toBe(found.total > 2);
  }).pipe(Effect.provide(guides)),
);

it.effect("reads a long guide in bounded parts that join back into the page", () =>
  Effect.gen(function* () {
    const service = yield* docs;
    const parts: Array<string> = [];
    let cursor: string | undefined;
    let first: UserDocs.UserGuideRead | undefined;
    do {
      const read = yield* service.read({ page: "remote-access", cursor });
      first ??= read;
      expect(read.markdown.length).toBeLessThanOrEqual(UserDocs.USER_GUIDE_READ_LIMIT);
      parts.push(read.markdown);
      cursor = read.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(parts.length).toBeGreaterThan(1);
    expect(first?.sections.some((section) => section.heading === "Tailscale HTTPS")).toBe(true);
    const whole = yield* service.read({ page: "remote-access", section: "tailscale-https" });
    expect(whole.heading).toBe("Tailscale HTTPS");
    expect(parts.join("")).toContain(whole.markdown.split("\n").slice(2).join("\n").slice(0, 200));
    expect(yield* service.read({ page: "remote-access", section: "Tailscale HTTPS" })).toEqual(
      whole,
    );
  }).pipe(Effect.provide(guides)),
);

it.effect("refuses an unknown page with the nearest guides and a cursor from another read", () =>
  Effect.gen(function* () {
    const service = yield* docs;
    const missing = yield* service.read({ page: "remote" }).pipe(Effect.flip);
    expect(missing).toMatchObject({ _tag: "UserGuideNotFoundError" });
    expect(missing._tag === "UserGuideNotFoundError" && missing.nearest).toContain("remote-access");
    const { nextCursor } = yield* service.read({ page: "remote-access" });
    expect(nextCursor).not.toBeNull();
    const crossed = yield* service
      .read({ page: "computer-use", cursor: nextCursor ?? undefined })
      .pipe(Effect.flip);
    expect(crossed).toMatchObject({ _tag: "UserGuideCursorError" });
  }).pipe(Effect.provide(guides)),
);

it.effect("serves the guides a packed build inlines, not the repository's", () =>
  Effect.gen(function* () {
    const global = globalThis as { __GOAT_USER_DOCS__?: Readonly<Record<string, string>> };
    global.__GOAT_USER_DOCS__ = { packed: "# Packed guide\n\n## Only part\n\nInlined text." };
    const service = yield* UserDocs.UserDocs.pipe(
      Effect.provide(guides),
      Effect.ensuring(Effect.sync(() => delete global.__GOAT_USER_DOCS__)),
    );
    expect((yield* service.index).guides.map((guide) => guide.page)).toEqual(["packed"]);
    expect((yield* service.search({ query: "inlined" })).matches[0]?.heading).toBe("Only part");
  }),
);

it("numbers repeated headings the way the site does", () => {
  const page = parseUserGuide(
    "demo",
    "# Demo\n\n## Setup\n\n### Setup\n\n## Setup\n\n```\n## Not a heading\n```\n",
  );
  expect(page.sections.map((section) => section.anchor)).toEqual(["setup", "setup-1", "setup-2"]);
});
