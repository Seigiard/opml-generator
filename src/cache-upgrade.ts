import { stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "./context.ts";
import type { FileInfo } from "./types.ts";
import { cachePath, decodeRelative, isContainer } from "./cache-projection.ts";
import { isReusableEpisodeCache } from "./rss/episode-cache.ts";
import { ENTRY_FILE } from "./constants.ts";
import { cacheFileSystem } from "./stopping.ts";
import { z } from "zod";

export async function needsCacheUpgrade(deps: HandlerDeps, check: () => void): Promise<boolean> {
  const fs = deps.fs;

  async function visit(directory: string): Promise<boolean> {
    check();

    for (const name of await fs.readdir(directory)) {
      check();
      const info = await fs.lstat(join(directory, name));
      check();

      if (!info.isDirectory()) continue;

      if (cachePath("", name) !== `/${name}`) return true;

      if (await visit(join(directory, name))) return true;
    }

    return false;
  }

  return visit(deps.config.dataPath);
}

export async function upgradeCache(
  files: readonly FileInfo[],
  deps: HandlerDeps,
  check: () => void,
): Promise<void> {
  const root = deps.config.dataPath;
  const fs = cacheFileSystem(deps);
  const journal = join(root, "~/.upgrade");
  const manifest = join(journal, "manifest.json");

  const stageSchema = z.array(
    z.object({ logical: z.string(), file: z.string().regex(/^\d+\.xml$/) }),
  );

  let staged: z.infer<typeof stageSchema> = [];

  if (await Bun.file(manifest).exists()) {
    staged = stageSchema.parse(await Bun.file(manifest).json());
    check();
  }

  const copies: Array<{ path: string; content: string }> = [];

  // Read the whole affected metadata snapshot before writes can occupy a legacy name.
  for (const file of files) {
    const canonical = join(cachePath(root, file.relativePath), ENTRY_FILE);
    const legacy = join(root, file.relativePath, ENTRY_FILE);

    if (canonical === legacy) continue;
    const saved = staged.find((row) => row.logical === file.relativePath);

    for (const path of [canonical, legacy, ...(saved ? [join(journal, saved.file)] : [])]) {
      check();

      try {
        const info = await stat(path);
        check();
        const content = await Bun.file(path).text();
        check();

        if (info.mtimeMs < file.mtime || !isReusableEpisodeCache(content, file)) continue;

        if (path !== canonical) copies.push({ path: canonical, content });
        break;
      } catch (error) {
        check();

        if (
          !(
            error instanceof Error &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
          )
        )
          throw error;
      }
    }
  }

  if (copies.length > 0) {
    await fs.mkdir(journal, { recursive: true });
    const rows: z.infer<typeof stageSchema> = [];

    for (const [index, copy] of copies.entries()) {
      check();
      const file = `${index}.xml`;
      await fs.atomicWrite(join(journal, file), copy.content);
      rows.push({ logical: decodeRelative(relative(root, dirname(copy.path))), file });
    }

    check();
    await fs.atomicWrite(manifest, JSON.stringify(rows));
    check();
  }

  async function prune(directory: string): Promise<void> {
    check();

    for (const name of await fs.readdir(directory)) {
      check();
      const path = join(directory, name);

      if (path === journal) continue;
      const info = await fs.lstat(path);
      check();

      if (!info.isDirectory()) continue;
      const physical = relative(root, path);

      if (isContainer(physical)) {
        await prune(path);
        continue;
      }

      const logical = decodeRelative(physical);

      if (cachePath(root, logical) !== path) await fs.rm(path, { recursive: true });
      else await prune(path);
      check();
    }
  }

  await prune(root);

  for (const copy of copies) {
    check();
    await fs.mkdir(dirname(copy.path), { recursive: true });
    check();
    await fs.atomicWrite(copy.path, copy.content);
    check();
  }

  if (await Bun.file(manifest).exists()) {
    check();
    await fs.rm(journal, { recursive: true });
    check();
  }
}
