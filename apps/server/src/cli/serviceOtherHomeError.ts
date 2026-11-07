export const formatBootServiceBaseDirOption = (baseDir: string) =>
  `--base-dir '${baseDir.replaceAll("'", `'"'"'`)}'`;
