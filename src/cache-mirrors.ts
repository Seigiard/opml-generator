import { join, relative } from "node:path";
import type { FileSystemService } from "./context.ts";
import { isContainer } from "./cache-projection.ts";

export async function cacheMirrors(
  directory: string,
  root: string,
  fs: Pick<FileSystemService, "stat" | "readdir">,
): Promise<Array<{ name: string; path: string }>> {
  const result: Array<{ name: string; path: string }> = [];
  const names = await fs.readdir(directory);

  for (const name of names) {
    const path = join(directory, name);
    const info = await fs.stat(path);

    if (!info.isDirectory()) continue;

    if (isContainer(relative(root, path))) {
      const escapedNames = await fs.readdir(path);

      for (const escaped of escapedNames) {
        const child = join(path, escaped);
        const info = await fs.stat(child);

        if (info.isDirectory()) result.push({ name: escaped, path: child });
      }
    } else result.push({ name, path });
  }

  return result;
}
