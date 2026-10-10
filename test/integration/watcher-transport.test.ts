import { afterEach, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "../helpers/fs-helpers.ts";
import { z } from "zod";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function serializer(input: Uint8Array) {
  const requests: Array<{ method: string; path: string; body: string }> = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({
        method: request.method,
        path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
        body: await request.text(),
      });

      return new Response("OK");
    },
  });

  const process = Bun.spawn(
    ["bun", "/app/src/watcher-events.ts", `http://127.0.0.1:${server.port}`, "books"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  process.stdin.write(input);
  process.stdin.end();
  const [status, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  await server.stop(true);

  return { status, requests, error };
}

test("real inotify truncated long-path output cannot emit desynchronized future records", async () => {
  // #given
  const root = await createTempDir("watcher-format-limit");
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  let directory = root;

  while (directory.length < 4073) {
    const remaining = 4073 - directory.length;
    directory =
      remaining === 1 ? `${directory}x` : join(directory, "x".repeat(Math.min(200, remaining - 1)));
  }

  await mkdir(directory, { recursive: true });

  const producer = Bun.spawn(
    [
      "inotifywait",
      "-m",
      "-r",
      "-e",
      "close_write",
      "--no-newline",
      "--format",
      "%w%0%f%0%e%0",
      root,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const chunks: Uint8Array[] = [];
  let length = 0;
  let shortObserved!: () => void;

  const shortReady = new Promise<void>((resolve) => {
    shortObserved = resolve;
  });

  const pump = (async () => {
    for await (const chunk of producer.stdout) {
      chunks.push(chunk);
      length += chunk.length;

      if (Buffer.concat(chunks).includes(Buffer.from("short.mp3\0"))) shortObserved();
    }
  })();

  cleanup.push(async () => {
    producer.kill("SIGTERM");
    await producer.exited;
    await pump;
  });
  let setup = "";

  for await (const chunk of producer.stderr) {
    setup += new TextDecoder().decode(chunk);

    if (setup.includes("Watches established.")) break;
  }

  if (!setup.includes("Watches established.")) throw new Error(`Native observer failed: ${setup}`);

  // #when
  await writeFile(join(directory, "1234567890123456.txt"), "long");
  await writeFile(join(root, "short.mp3"), "short");
  await shortReady;
  producer.kill("SIGTERM");
  await producer.exited;
  await pump;
  const result = await serializer(Buffer.concat(chunks, length));

  // #then
  expect({ failed: result.status !== 0, requests: result.requests }).toEqual({
    failed: true,
    requests: [],
  });
}, 15_000);

test("the installed Q_OVERFLOW token routes a recovery POST instead of a books hint", async () => {
  // #given
  const libraries = await readdir("/usr/lib");
  const name = libraries.find((entry) => entry.startsWith("libinotifytools.so."));

  if (!name) throw new Error("Installed inotify native formatter is unavailable");

  const native = dlopen(join("/usr/lib", name), {
    inotifytools_event_to_str: { args: [FFIType.i32], returns: FFIType.cstring },
  });

  // Linux IN_Q_OVERFLOW is 0x4000. Ask the installed formatter for its wire token.
  const token = String(native.symbols.inotifytools_event_to_str(0x4000));
  native.close();

  const selected = Bun.spawn(["inotifywait", "-e", token, "-t", "1", "/tmp"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const selectionStatus = await selected.exited;

  // #when
  const result = await serializer(new TextEncoder().encode(`\0\0${token}\0`));

  // #then
  expect({ token, selectionStatus, status: result.status, requests: result.requests }).toEqual({
    token: "Q_OVERFLOW",
    selectionStatus: 2,
    status: 0,
    requests: [{ method: "POST", path: "/resync?force=1", body: "" }],
  });
}, 10_000);

test("damaged native framing explicitly terminates the owned worker group", async () => {
  // #given
  const root = await createTempDir("watcher-worker-damage");
  let directory = root;

  while (directory.length < 4073) {
    const remaining = 4073 - directory.length;
    directory =
      remaining === 1 ? `${directory}x` : join(directory, "x".repeat(Math.min(200, remaining - 1)));
  }

  await mkdir(directory, { recursive: true });
  const fields = z.object({ parent: z.string(), name: z.string(), events: z.string() });
  const requests: Array<z.infer<typeof fields>> = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push(fields.parse(await request.json()));

      return new Response("OK");
    },
  });

  const worker = Bun.spawn(["setsid", "sh", "/app/src/watcher.sh", "worker", root, "books"], {
    env: { ...process.env, PORT: String(server.port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  cleanup.push(async () => {
    try {
      process.kill(-worker.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }

    await worker.exited;
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;

  while (!requests.some((request) => request.name === "control.mp3")) {
    if (Date.now() > deadline) throw new Error("Native worker did not admit its control event");
    await writeFile(join(root, "control.mp3"), "control");
    await Bun.sleep(25);
  }

  // #when
  await writeFile(join(directory, "1234567890123456.txt"), "long");
  await writeFile(join(root, "short.mp3"), "short");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number;

  try {
    status = await Promise.race([
      worker.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Damaged framing left the worker running")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  // #then
  expect({
    failed: status !== 0,
    invalid: requests.filter(
      (request) => request.events === "short.mp3" || request.name.includes("/"),
    ).length,
  }).toEqual({ failed: true, invalid: 0 });
}, 15_000);
