import { appendFile } from "node:fs/promises";
import { buildContext } from "../../src/context.ts";
import { runServer } from "../../src/server.ts";

// Only this mounted bootstrap decorates the production filesystem boundary.
// The production server owns HTTP, signal handling, consumers, and shutdown.
await runServer(async () => {
  const ctx = await buildContext();
  const fs = { ...ctx.fs };

  async function record(value: { operation?: string; completed?: string; path: string }) {
    await appendFile("/shutdown-control/operations.jsonl", `${JSON.stringify(value)}\n`);
  }

  const configuration = Bun.file("/shutdown-control/gate.json");

  const gate: { operation: string; suffix: string; stage: string } | undefined =
    (await configuration.exists()) ? await configuration.json() : undefined;

  let held = false;

  async function operation<T>(name: string, path: string, work: () => Promise<T>): Promise<T> {
    await record({ operation: name, path });
    const selected = !held && gate?.operation === name && path.endsWith(gate.suffix);

    const wait = async () => {
      held = true;
      await Bun.write("/shutdown-control/entered", path);

      while (!(await Bun.file("/shutdown-control/release").exists())) await Bun.sleep(20);
    };

    if (selected && gate?.stage === "before") await wait();
    const result = await work();

    if (selected && gate?.stage === "after") await wait();
    await record({ completed: name, path });

    return result;
  }

  fs.mkdir = (path, options) => operation("mkdir", path, () => ctx.fs.mkdir(path, options));
  fs.rm = (path, options) => operation("rm", path, () => ctx.fs.rm(path, options));
  fs.readdir = (path) => operation("readdir", path, () => ctx.fs.readdir(path));
  fs.atomicWrite = (path, content) =>
    operation("atomicWrite", path, () => ctx.fs.atomicWrite(path, content));

  return { ...ctx, fs };
});
