import type { FileSystemService } from "./context.ts";

const originals = new WeakMap<FileSystemService, FileSystemService>();

const guards = new WeakMap<FileSystemService, () => void>();

export function checkFileSystemAccess(fs: FileSystemService): void {
  guards.get(fs)?.();
}

export function filesystemIdentity(fs: FileSystemService): FileSystemService {
  return originals.get(fs) ?? fs;
}

export function guardFileSystem(fs: FileSystemService, check: () => void): FileSystemService {
  const guarded: FileSystemService = {
    mkdir: (path, options) => {
      check();

      return fs.mkdir(path, options);
    },
    rm: (path, options) => {
      check();

      return fs.rm(path, options);
    },
    readdir: (path) => {
      check();

      return fs.readdir(path);
    },
    stat: (path) => {
      check();

      return fs.stat(path);
    },
    lstat: (path) => {
      check();

      return fs.lstat(path);
    },
    exists: (path) => {
      check();

      return fs.exists(path);
    },
    writeFile: (path, content) => {
      check();

      return fs.writeFile(path, content);
    },
    atomicWrite: (path, content) => {
      check();

      return fs.atomicWrite(path, content);
    },
    symlink: (target, path) => {
      check();

      return fs.symlink(target, path);
    },
    unlink: (path) => {
      check();

      return fs.unlink(path);
    },
  };

  originals.set(guarded, filesystemIdentity(fs));
  guards.set(guarded, check);

  return guarded;
}
