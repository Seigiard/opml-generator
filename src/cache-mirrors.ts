import { join, relative } from "node:path";
import type { FileSystemService } from "./context.ts";
import { isContainer } from "./cache-projection.ts";

export async function cacheMirrors(
  directory: string,
  root: string,
  fs: Pick<FileSystemService, "stat" | "readdir">,
  check: () => void = () => {},
): Promise<Array<{ name: string; path: string }>> {
  const result: Array<{ name: string; path: string }> = [];
  check();
  const names = await fs.readdir(directory);
  check();

  for (const name of names) {
    const path = join(directory, name);
    check();
    const info = await fs.stat(path);
    check();

    if (!info.isDirectory()) continue;

    if (isContainer(relative(root, path))) {
      const escapedNames = await fs.readdir(path);
      check();

      for (const escaped of escapedNames) {
        const child = join(path, escaped);
        check();
        const info = await fs.stat(child);
        check();

        if (info.isDirectory()) result.push({ name: escaped, path: child });
      }
    } else result.push({ name, path });
  }

  return result;
}
