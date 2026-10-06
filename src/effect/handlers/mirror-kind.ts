import { join } from "node:path";
import type { FileSystemService } from "../../context.ts";
import { ENTRY_FILE } from "../../constants.ts";

export async function prepareMirrorKind(
  dataDir: string,
  isDirectory: boolean,
  fs: FileSystemService,
): Promise<void> {
  let children: string[];

  try {
    children = await fs.readdir(dataDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  for (const child of children) {
    if ((child === ENTRY_FILE) === isDirectory) {
      await fs.rm(join(dataDir, child), { recursive: true });
    }
  }
}
