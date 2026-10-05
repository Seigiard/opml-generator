import { mkdtemp, rm, mkdir, cp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export async function cleanupTempDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

export async function copyFixture(fixturePath: string, destDir: string): Promise<string> {
  const fileName = fixturePath.split("/").pop()!;
  const destPath = join(destDir, fileName);
  await cp(fixturePath, destPath);

  return destPath;
}

export interface FileTree {
  [name: string]: string | Buffer | FileTree;
}

export async function createFileStructure(root: string, structure: FileTree): Promise<void> {
  await mkdir(root, { recursive: true });

  for (const [name, content] of Object.entries(structure)) {
    const path = join(root, name);

    const file = z.union([z.string(), z.instanceof(Buffer)]).safeParse(content);

    if (file.success) {
      await Bun.write(path, file.data);
    } else {
      // SAFETY: FileTree values are text, Buffer, or nested FileTree; the two
      // file variants were decoded above, leaving only a nested directory.
      await createFileStructure(path, content as FileTree);
    }
  }
}

export async function assertFileExists(path: string): Promise<void> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    throw new Error(`Expected file to exist: ${path}`);
  }
}

export async function assertDirectoryContains(dir: string, expectedFiles: string[]): Promise<void> {
  const files = await readdir(dir);

  for (const expected of expectedFiles) {
    if (!files.includes(expected)) {
      throw new Error(
        `Expected directory ${dir} to contain ${expected}, found: ${files.join(", ")}`,
      );
    }
  }
}

export async function getFileCount(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });

  return entries.filter((e) => e.isFile()).length;
}
