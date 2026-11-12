/**
 * Another machine's words as this machine shows them: quoted after a label of our own and cut to
 * fit, so the closing quote and whatever this machine adds after it always survive.
 */
export const quoteRemote = (label: string, text: string, max: number) => {
  let body = text;
  let quoted = label + JSON.stringify(body);
  while (quoted.length > max && body.length > 0) {
    body = body.slice(0, Math.max(0, body.length - (quoted.length - max) - 1));
    quoted = label + JSON.stringify(body + "…");
  }
  return quoted;
};
