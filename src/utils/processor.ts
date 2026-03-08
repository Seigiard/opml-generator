export function encodeUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeFilenameTitle(filename: string): string {
  const hyphens = (filename.match(/-/g) || []).length;
  const underscores = (filename.match(/_/g) || []).length;

  let result = filename.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  if (hyphens > underscores) {
    result = result.replace(/-+/g, " ");
  } else {
    result = result.replace(/_+/g, " ");
  }

  result = result.replace(/\s+/g, " ").trim();
  return result.charAt(0).toUpperCase() + result.slice(1);
}

export function formatFolderDescription(folderCount: number, audioFileCount: number): string | undefined {
  if (folderCount === 0 && audioFileCount === 0) return undefined;
  if (folderCount === 0) return `📚 ${audioFileCount}`;
  if (audioFileCount === 0) return `🗂 ${folderCount}`;
  return `🗂 ${folderCount} · 📚 ${audioFileCount}`;
}
