export function encodeUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
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

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalSort(a: string, b: string): number {
  return collator.compare(a, b);
}
