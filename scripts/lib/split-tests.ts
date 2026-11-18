const NODE_TEST = /^\.github[/\\]scripts[/\\]/;

export function splitTests(tests: Iterable<string>) {
  const all = [...tests];
  return {
    vitestTests: all.filter((file) => !NODE_TEST.test(file)),
    nodeTests: all.filter((file) => NODE_TEST.test(file)),
  };
}

export function changedVitestBatches(tests: ReadonlyArray<string>) {
  const serverPrefix = "apps/server/";
  const server: Array<string> = [];
  const workspace: Array<string> = [];
  for (const file of tests) {
    if (file.startsWith(serverPrefix)) server.push(file.slice(serverPrefix.length));
    else workspace.push(file);
  }
  return [
    ...(server.length > 0 ? [{ cwd: "apps/server", files: server }] : []),
    ...(workspace.length > 0 ? [{ cwd: ".", files: workspace }] : []),
  ];
}
