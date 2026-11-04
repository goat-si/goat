const NODE_TEST = /^\.github[/\\]scripts[/\\]/;

export function splitTests(tests: Iterable<string>) {
  const all = [...tests];
  return {
    vitestTests: all.filter((file) => !NODE_TEST.test(file)),
    nodeTests: all.filter((file) => NODE_TEST.test(file)),
  };
}
