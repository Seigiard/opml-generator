import type { FileSystemService, HandlerDeps } from "./context.ts";
import { assertCachePath, checkCacheMutation } from "./cache-boundary.ts";

const originals = new WeakMap<FileSystemService, FileSystemService>();

export function filesystemIdentity(fs: FileSystemService): FileSystemService {
  return originals.get(fs) ?? fs;
}

export function cacheFileSystem(deps: Pick<HandlerDeps, "fs" | "config">): FileSystemService {
  return guardFileSystem(deps.fs, deps.config.dataPath);
}

function guardFileSystem(fs: FileSystemService, dataPath: string): FileSystemService {
  const mutation = async (path: string, leafWrite = false, remove = false) => {
    assertCachePath(path, dataPath, !remove);
    await checkCacheMutation(path, dataPath, fs, leafWrite);
  };

  const guarded: FileSystemService = {
    mkdir: async (path, options) => {
      await mutation(path, true);

      return fs.mkdir(path, options);
    },
    rm: async (path, options) => {
      await mutation(path, false, true);

      return fs.rm(path, options);
    },
    readdir: (path) => fs.readdir(path),
    stat: (path) => fs.stat(path),
    lstat: (path) => fs.lstat(path),
    exists: (path) => fs.exists(path),
    writeFile: async (path, content) => {
      await mutation(path, true);

      return fs.writeFile(path, content);
    },
    atomicWrite: async (path, content) => {
      await mutation(path, true);
      await mutation(`${path}.tmp`, true);

      return fs.atomicWrite(path, content);
    },
    symlink: async (target, path) => {
      await mutation(path);

      return fs.symlink(target, path);
    },
    unlink: async (path) => {
      await mutation(path, false, true);

      return fs.unlink(path);
    },
  };

  originals.set(guarded, filesystemIdentity(fs));

  return guarded;
}
