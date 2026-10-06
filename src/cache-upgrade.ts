import { stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "./context.ts";
import type { FileInfo } from "./types.ts";
import { cachePath, decodeRelative, isContainer } from "./cache-projection.ts";
import { isReusableEpisodeCache } from "./rss/episode-cache.ts";
import { ENTRY_FILE } from "./constants.ts";
import { cacheFileSystem } from "./stopping.ts";
import { z } from "zod";

function isEscapedName(name: string): boolean {
  return cachePath("", name) !== `/${name}`;
}

export async function needsCacheUpgrade(deps: HandlerDeps, check: () => void): Promise<boolean> {
  const fs = deps.fs;

  async function visit(directory: string, container: boolean): Promise<boolean> {
    check();

    for (const name of await fs.readdir(directory)) {
      check();
      const path = join(directory, name);
      const info = await fs.lstat(path);
      check();

      if (!info.isDirectory()) continue;

      // A container holds only escaped names; anything else is a legacy branch or a journal.
      if (container ? !isEscapedName(name) : name !== "~" && isEscapedName(name)) return true;

      if (await visit(path, !container && name === "~")) return true;
    }

    return false;
  }

  return visit(deps.config.dataPath, false);
}

const journalName = /^\.upgrade(-\d+)?$/;

const absentError = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

async function lstatOrAbsent(fs: HandlerDeps["fs"], path: string) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (absentError.safeParse(error).success) return undefined;
    throw error;
  }
}

// A legacy cache never holds a regular manifest.json, so it identifies a journal at any name.
async function findJournal(fs: HandlerDeps["fs"], container: string, check: () => void) {
  const info = await lstatOrAbsent(fs, container);
  check();

  if (!info?.isDirectory()) return undefined;

  for (const name of await fs.readdir(container)) {
    check();

    if (!journalName.test(name)) continue;
    const manifest = await lstatOrAbsent(fs, join(container, name, "manifest.json"));
    check();

    if (manifest?.isFile()) return join(container, name);
  }

  return undefined;
}

async function freeJournal(fs: HandlerDeps["fs"], container: string, check: () => void) {
  for (let index = 0; ; index++) {
    const path = join(container, index === 0 ? ".upgrade" : `.upgrade-${index}`);
    const info = await lstatOrAbsent(fs, path);
    check();

    if (!info) return path;
  }
}

export async function upgradeCache(
  files: readonly FileInfo[],
  deps: HandlerDeps,
  check: () => void,
): Promise<void> {
  const root = deps.config.dataPath;
  const fs = cacheFileSystem(deps);
  const container = join(root, "~");
  let journal = await findJournal(fs, container, check);

  const stageSchema = z.array(
    z.object({ logical: z.string(), file: z.string().regex(/^\d+\.xml$/) }),
  );

  let staged: z.infer<typeof stageSchema> = [];

  if (journal) {
    staged = stageSchema.parse(await Bun.file(join(journal, "manifest.json")).json());
    check();
  }

  const copies: Array<{ path: string; content: string; file: string | undefined }> = [];

  // Read the whole affected metadata snapshot before writes can occupy a legacy name.
  for (const file of files) {
    const canonical = join(cachePath(root, file.relativePath), ENTRY_FILE);
    const legacy = join(root, file.relativePath, ENTRY_FILE);

    if (canonical === legacy) continue;
    const saved = staged.find((row) => row.logical === file.relativePath);
    const journalCopy = saved && journal ? join(journal, saved.file) : undefined;

    for (const path of [canonical, legacy, ...(journalCopy ? [journalCopy] : [])]) {
      check();

      try {
        const info = await stat(path);
        check();
        const content = await Bun.file(path).text();
        check();

        if (info.mtimeMs < file.mtime || !isReusableEpisodeCache(content, file)) continue;

        if (path !== canonical)
          copies.push({
            path: canonical,
            content,
            file: path === journalCopy ? saved?.file : undefined,
          });
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
    journal ??= await freeJournal(fs, container, check);
    await fs.mkdir(journal, { recursive: true });
    const rows: z.infer<typeof stageSchema> = [];
    // The current manifest still references its staged files until it is replaced.
    let next = Math.max(-1, ...staged.map((row) => Number.parseInt(row.file))) + 1;

    for (const copy of copies) {
      check();
      let file = copy.file;

      if (!file) {
        file = `${next++}.xml`;
        await fs.atomicWrite(join(journal, file), copy.content);
      }

      rows.push({ logical: decodeRelative(relative(root, dirname(copy.path))), file });
    }

    check();
    await fs.atomicWrite(join(journal, "manifest.json"), JSON.stringify(rows));
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

  if (journal) {
    check();
    await fs.rm(journal, { recursive: true });
    check();
  }
}
