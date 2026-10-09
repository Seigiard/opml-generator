import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileSystemService } from "./context.ts";
import { cachePath, decodeRelative } from "./cache-projection.ts";

export function assertCachePath(path: string, root: string, allowRoot = true): string {
  const normalized = resolve(path);
  const local = relative(resolve(root), normalized);

  if (
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local) ||
    (!allowRoot && local === "")
  ) {
    throw new Error(`Cache path outside owned scope: ${path}`);
  }

  return normalized;
}

export function cacheParent(path: string, root: string): string | undefined {
  const normalized = assertCachePath(path, root);

  return normalized === resolve(root)
    ? undefined
    : cachePath(
        resolve(root),
        dirname(decodeRelative(relative(resolve(root), normalized))) === "."
          ? ""
          : dirname(decodeRelative(relative(resolve(root), normalized))),
      );
}

export async function checkCacheMutation(
  path: string,
  root: string,
  fs: FileSystemService,
  leafWrite = false,
): Promise<void> {
  const normalized = assertCachePath(path, root);
  const local = relative(resolve(root), normalized);
  let current = resolve(root);
  const components = local.split(sep).filter(Boolean);
  const paths = [current];

  for (const name of components) {
    current = join(current, name);
    paths.push(current);
  }

  for (const candidate of leafWrite ? paths : paths.slice(0, -1)) {
    try {
      const entry = await fs.lstat(candidate);
      const leaf = candidate === normalized;

      if (!(entry.isDirectory() || (leaf && entry.isFile())))
        throw new Error(`Cache mutation crosses a non-regular path: ${candidate}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
