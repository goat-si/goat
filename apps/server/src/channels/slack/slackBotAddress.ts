export function* slackBotAddresses(text: string) {
  const head = /^[^\r\n]{1,65}/u.exec(text.normalize("NFC"))?.[0] ?? "";
  const addresses = [];
  let originalColon = -1;
  for (const { index } of head.matchAll(/:/gu)) {
    // NFC leaves ASCII colons in order, so the delimiter can still index the original body.
    originalColon = text.indexOf(":", originalColon + 1);
    const delimiter = /^:[ \t]+(?=\S)/u.exec(text.slice(originalColon));
    if (delimiter !== null) {
      addresses.push({
        name: head.slice(0, index).trim(),
        bodyStart: originalColon + delimiter[0].length,
      });
    }
  }
  yield* addresses.reverse();
}
