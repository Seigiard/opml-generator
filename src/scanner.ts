import { readdir, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import type { FileInfo, FolderInfo } from "./types.ts";
import { AUDIO_EXTENSIONS } from "./types.ts";
import { ENTRY_FILE } from "./constants.ts";
import { isReusableEpisodeCache } from "./rss/episode-cache.ts";
import { cachePath } from "./cache-projection.ts";
import { cacheMirrors } from "./cache-mirrors.ts";

export async function scanFiles(rootPath: string, signal?: AbortSignal): Promise<FileInfo[]> {
  const files: FileInfo[] = [];

  async function scan(dirPath: string): Promise<void> {
    signal?.throwIfAborted();
    const entries = await readdir(dirPath, { withFileTypes: true });
    signal?.throwIfAborted();

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
        signal?.throwIfAborted();
      } else if (entry.isFile()) {
        const ext = extname(entry.name).slice(1).toLowerCase();

        if (AUDIO_EXTENSIONS.includes(ext)) {
          const fileStat = await stat(fullPath);
          signal?.throwIfAborted();
          files.push({
            path: fullPath,
            relativePath: relative(rootPath, fullPath),
            size: fileStat.size,
            mtime: fileStat.mtimeMs,
            extension: ext,
          });
        }
      }
    }
  }

  await scan(rootPath);
  signal?.throwIfAborted();

  return files;
}

export function buildFolderStructure(files: FileInfo[]): FolderInfo[] {
  const folderSet = new Set<string>();
  folderSet.add("");

  for (const file of files) {
    const parts = file.relativePath.split("/");
    parts.pop();

    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      folderSet.add(currentPath);
    }
  }

  // Count audio files per folder (direct children only)
  const audioFileCounts = new Map<string, number>();

  for (const file of files) {
    const parts = file.relativePath.split("/");
    parts.pop();
    const folderPath = parts.join("/");
    audioFileCounts.set(folderPath, (audioFileCounts.get(folderPath) ?? 0) + 1);
  }

  const folders: FolderInfo[] = [];

  for (const path of folderSet) {
    const subfolders = Array.from(folderSet).filter((f) => {
      if (f === path) return false;
      const prefix = path === "" ? "" : path + "/";

      if (!f.startsWith(prefix)) return false;
      const rest = f.slice(prefix.length);

      return !rest.includes("/");
    });

    folders.push({
      path,
      name: path.split("/").pop() || "Catalog",
      subfolders,
      audioFileCount: audioFileCounts.get(path) ?? 0,
    });
  }

  return folders;
}

async function scanDataMirror(dataPath: string, signal?: AbortSignal): Promise<Set<string>> {
  const paths = new Set<string>();
  const fs = { stat, readdir: (path: string) => readdir(path) };

  async function scan(dirPath: string, relativePath: string): Promise<void> {
    try {
      signal?.throwIfAborted();
      const entries = await cacheMirrors(dirPath, dataPath, fs, () => signal?.throwIfAborted());
      signal?.throwIfAborted();

      for (const entry of entries) {
        const entryPath = entry.path;
        const logicalName = entry.name;
        const entryRelPath = relativePath ? `${relativePath}/${logicalName}` : logicalName;
        paths.add(entryRelPath);
        const hasAudioEntry = await Bun.file(join(entryPath, ENTRY_FILE)).exists();
        signal?.throwIfAborted();

        if (!hasAudioEntry) {
          await scan(entryPath, entryRelPath);
          signal?.throwIfAborted();
        }
      }
    } catch (error) {
      signal?.throwIfAborted();

      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  await scan(dataPath, "");
  signal?.throwIfAborted();

  return paths;
}

export interface SyncPlan {
  toProcess: FileInfo[];
  toDelete: string[];
  folders: FolderInfo[];
}

export async function createSyncPlan(
  files: FileInfo[],
  dataPath: string,
  signal?: AbortSignal,
): Promise<SyncPlan> {
  signal?.throwIfAborted();
  const folders = buildFolderStructure(files);
  const existingPaths = await scanDataMirror(dataPath, signal);
  signal?.throwIfAborted();

  const currentFilePaths = new Set(files.map((f) => f.relativePath));
  const currentFolderPaths = new Set(folders.map((f) => f.path).filter((p) => p !== ""));

  const toProcess: FileInfo[] = [];
  const toDelete: string[] = [];
  const foldersToProcess: FolderInfo[] = [];

  for (const file of files) {
    const dataDir = cachePath(dataPath, file.relativePath);
    const entryFile = Bun.file(join(dataDir, ENTRY_FILE));

    try {
      const entryStat = await stat(join(dataDir, ENTRY_FILE));
      signal?.throwIfAborted();

      if (file.mtime > entryStat.mtimeMs) {
        toProcess.push(file);
      } else {
        const content = await entryFile.text();
        signal?.throwIfAborted();

        if (!isReusableEpisodeCache(content, file)) toProcess.push(file);
      }
    } catch {
      signal?.throwIfAborted();
      // Unreadable metadata cannot be reused; the audio handler owns the rebuild result.
      toProcess.push(file);
    }
  }

  for (const path of existingPaths) {
    if (!currentFilePaths.has(path) && !currentFolderPaths.has(path)) {
      // A removed subtree needs one cleanup, not cascades into its removed descendants.
      if (!toDelete.some((parent) => path.startsWith(`${parent}/`))) toDelete.push(path);
    }
  }

  // Always regenerate folders to keep counts up to date (including root for feed.xml)
  for (const folder of folders) {
    foldersToProcess.push(folder);
  }

  return { toProcess, toDelete, folders: foldersToProcess };
}

export function computeHash(files: FileInfo[]): string {
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const data = sorted.map((f) => `${f.relativePath}|${f.size}|${Math.floor(f.mtime)}`).join("\n");

  return Bun.hash(data).toString(16);
}
