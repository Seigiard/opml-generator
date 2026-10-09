import { join, relative } from "node:path";
import type { FileSystemService } from "./context.ts";
import { isContainer } from "./cache-projection.ts";

const ENGINE_STATE_RELATIVE_PATH = "~/.sync-engine";

function isAbsentPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export async function cacheMirrors(
  directory: string,
  root: string,
  fs: Pick<FileSystemService, "stat" | "readdir">,
): Promise<Array<{ name: string; path: string }>> {
  const result: Array<{ name: string; path: string }> = [];
  const names = await fs.readdir(directory);

  for (const name of names) {
    const path = join(directory, name);
    const info = await fs.stat(path).catch((error: unknown) => {
      if (isAbsentPathError(error)) return null;

      throw error;
    });

    if (!info) continue;

    if (!info.isDirectory()) continue;

    if (isContainer(relative(root, path))) {
      const escapedNames = await fs.readdir(path).catch((error: unknown) => {
        if (isAbsentPathError(error)) return [];

        throw error;
      });

      for (const escaped of escapedNames) {
        const child = join(path, escaped);

        if (relative(root, child) === ENGINE_STATE_RELATIVE_PATH) continue;

        const info = await fs.stat(child).catch((error: unknown) => {
          if (isAbsentPathError(error)) return null;

          throw error;
        });

        if (!info) continue;

        if (info.isDirectory()) result.push({ name: escaped, path: child });
      }
    } else result.push({ name, path });
  }

  return result;
}
