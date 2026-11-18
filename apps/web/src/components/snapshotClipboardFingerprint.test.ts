import { describe, expect, it } from "vite-plus/test";
import {
  readSnapshotClipboardWrapper,
  snapshotClipboardHtml,
} from "./snapshotClipboardFingerprint";

const fingerprint = `2x1:${"a".repeat(64)}`;
const html = snapshotClipboardHtml("Snapshot", "{}", fingerprint);
const openingTag = html.slice(0, html.indexOf(">") + 1);

describe("readSnapshotClipboardWrapper", () => {
  it("rejects oversized clipboard HTML even when it begins with a valid wrapper", () => {
    expect(readSnapshotClipboardWrapper(html + " ".repeat(2 * 1024 * 1024))).toBeNull();
  });

  it("skips incomplete opening tags and returns only the correctly delimited wrapper", () => {
    expect(readSnapshotClipboardWrapper("<pre unfinished ".repeat(4096) + html)).toEqual({
      html: openingTag,
      fingerprint,
    });
  });

  it.each([
    html.replace("<pre ", "<preview "),
    `<!-- ${html} -->`,
    `<pre title='${openingTag}'>Snapshot</pre>`,
  ])("ignores an apparent fingerprint outside a pre attribute", (malformed) => {
    expect(readSnapshotClipboardWrapper(malformed)).toBeNull();
  });

  it("keeps quoted greater-than characters inside the surrounding browser tag", () => {
    const decorated = openingTag.replace("<pre ", '<pre title="a > b" ');
    expect(
      readSnapshotClipboardWrapper(`<html><!--StartFragment-->${decorated}Snapshot</pre>`),
    ).toEqual({ html: decorated, fingerprint });
  });
});
