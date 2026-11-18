/**
 * expo-file-system needs a `file:` URI, while expo-sqlite and expo-image report plain paths;
 * Android's File rejects a plain one ("URI is not absolute"), iOS accepts it.
 */
export function localFileUri(pathOrUri: string): string {
  if (pathOrUri.startsWith("file:")) return pathOrUri;
  if (!pathOrUri.startsWith("/")) throw new Error(`Not an absolute path: ${pathOrUri}`);
  return `file://${pathOrUri.split("/").map(encodeURIComponent).join("/")}`;
}
