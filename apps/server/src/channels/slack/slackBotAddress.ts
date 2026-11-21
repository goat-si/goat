export function* slackBotAddresses(text: string) {
  const head = /^[^\r\n]{1,65}/u.exec(text)?.[0] ?? "";
  for (let colon = head.lastIndexOf(":"); colon > 0; colon = head.lastIndexOf(":", colon - 1)) {
    const delimiter = /^:[ \t]+(?=\S)/u.exec(text.slice(colon));
    if (delimiter !== null) {
      yield { name: text.slice(0, colon).trim(), bodyStart: colon + delimiter[0].length };
    }
  }
}
