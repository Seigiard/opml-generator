import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { COVER_FILENAMES, IMAGE_EXTENSIONS } from "../constants.ts";

export async function findFolderCover(folderPath: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(folderPath);
  } catch {
    return null;
  }

  const lowercaseMap = new Map(entries.map((e) => [e.toLowerCase(), e]));

  for (const name of COVER_FILENAMES) {
    const match = lowercaseMap.get(name);
    if (match) return join(folderPath, match);
  }

  const imageFile = entries.find((e) => IMAGE_EXTENSIONS.some((ext) => e.toLowerCase().endsWith(ext)));
  if (imageFile) return join(folderPath, imageFile);

  return null;
}
