export interface NoteDiffLine {
  readonly text: string;
  readonly kind: "unchanged" | "added" | "removed";
}

// Bound both the quadratic LCS table and the number of rendered line rows.
const MAX_LCS_CELLS = 250_000;
const MAX_DIFF_LINES = 2_000;
const MAX_DIFF_CHARACTERS = 128_000;

/** Compare the hub baseline with the phone draft without normalizing either version. */
export function diffNoteLines(phoneBody: string, hubBody: string) {
  const phone = phoneBody === "" ? [] : phoneBody.split("\n", MAX_DIFF_LINES + 1);
  const hub = hubBody === "" ? [] : hubBody.split("\n", MAX_DIFF_LINES + 1);
  if (
    phoneBody.length + hubBody.length > MAX_DIFF_CHARACTERS ||
    phone.length > MAX_DIFF_LINES ||
    hub.length > MAX_DIFF_LINES ||
    (phone.length + 1) * (hub.length + 1) > MAX_LCS_CELLS
  ) {
    return {
      phone: [{ text: phoneBody, kind: phoneBody === hubBody ? "unchanged" : "added" }],
      hub: [{ text: hubBody, kind: phoneBody === hubBody ? "unchanged" : "removed" }],
      wholeBlock: true,
    } satisfies { phone: NoteDiffLine[]; hub: NoteDiffLine[]; wholeBlock: boolean };
  }
  const width = hub.length + 1;
  const lengths = new Uint32Array((phone.length + 1) * width);
  for (let p = phone.length - 1; p >= 0; p--) {
    for (let h = hub.length - 1; h >= 0; h--) {
      lengths[p * width + h] =
        phone[p] === hub[h]
          ? lengths[(p + 1) * width + h + 1]! + 1
          : Math.max(lengths[(p + 1) * width + h]!, lengths[p * width + h + 1]!);
    }
  }
  const phoneLines: NoteDiffLine[] = [];
  const hubLines: NoteDiffLine[] = [];
  let p = 0;
  let h = 0;
  while (p < phone.length || h < hub.length) {
    if (p < phone.length && h < hub.length && phone[p] === hub[h]) {
      phoneLines.push({ text: phone[p++]!, kind: "unchanged" });
      hubLines.push({ text: hub[h++]!, kind: "unchanged" });
    } else if (
      p < phone.length &&
      (h === hub.length || lengths[(p + 1) * width + h]! >= lengths[p * width + h + 1]!)
    ) {
      phoneLines.push({ text: phone[p++]!, kind: "added" });
    } else {
      hubLines.push({ text: hub[h++]!, kind: "removed" });
    }
  }
  return { phone: phoneLines, hub: hubLines, wholeBlock: false };
}
