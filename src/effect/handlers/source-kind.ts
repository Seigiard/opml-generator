import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { FileSystemService } from "../../context.ts";
import { AUDIO_EXTENSIONS } from "../../types.ts";

type SourceEntry = { kind: "audio"; size: number } | { kind: "directory" | "excluded" | "missing" };

export async function readSourceEntry(
  path: string,
  root: string,
  fs: FileSystemService,
): Promise<SourceEntry> {
  const local = relative(root, path);

  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    return { kind: "excluded" };

  try {
    let currentPath = root;
    let current = await fs.lstat(currentPath);

    for (const name of local.split(sep).filter(Boolean)) {
      if (!current.isDirectory()) return { kind: "excluded" };
      currentPath = join(currentPath, name);
      current = await fs.lstat(currentPath);
    }

    if (current.isDirectory()) return { kind: "directory" };

    if (current.isFile() && AUDIO_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) {
      return { kind: "audio", size: current.size };
    }

    return { kind: "excluded" };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return { kind: "missing" };
    throw error;
  }
}
