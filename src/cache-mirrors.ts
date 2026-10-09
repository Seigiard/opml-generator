import { join, relative } from "node:path";
import { z } from "zod";
import type { FileSystemService } from "./context.ts";
import { isContainer } from "./cache-projection.ts";
import { OPML_ENGINE_STATE_RELATIVE_PATH } from "./engine/policy.ts";

const absentPathError = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

const noEntries: string[] = [];

async function absentAs<T, F>(read: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await read();
  } catch (error) {
    if (absentPathError.safeParse(error).success) return fallback;

    throw error;
  }
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

    const info = await absentAs(() => fs.stat(path), null);

    if (!info) continue;

    if (!info.isDirectory()) continue;

    if (isContainer(relative(root, path))) {
      const escapedNames = await absentAs(() => fs.readdir(path), noEntries);

      for (const escaped of escapedNames) {
        const child = join(path, escaped);

        if (relative(root, child) === OPML_ENGINE_STATE_RELATIVE_PATH) continue;

        const info = await absentAs(() => fs.stat(child), null);

        if (!info) continue;

        if (info.isDirectory()) result.push({ name: escaped, path: child });
      }
    } else result.push({ name, path });
  }

  return result;
}
