import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const project = process.env.SMOKE_PROJECT ?? "opml49-63-smoke";

const port = process.env.SMOKE_PORT ?? "18064";

const baseUrl = `http://localhost:${port}`;

const composeEnv = { ...process.env, COMPOSE_PROJECT_NAME: project, TEST_PORT: port };

const sourceRoot = join(import.meta.dir, "..", "files");

const fixtures = [
  { source: "feed.xml", publicPath: "/feed.xml/feed.xml", dataFeed: "/data/~/feed.xml/feed.xml" },
  {
    source: "draft.tmp",
    publicPath: "/draft.tmp/feed.xml",
    dataFeed: "/data/~/draft.tmp/feed.xml",
  },
  { source: "~", publicPath: "/~/feed.xml", dataFeed: "/data/~/~/feed.xml" },
];

const readySchema = z.object({
  available: z.boolean(),
  availableFrom: z.string().nullable(),
  completed: z.boolean(),
  failure: z.unknown().nullable(),
});

async function compose(...args: string[]) {
  return Bun.$`docker compose -f docker-compose.e2e.yml ${args}`.env(composeEnv).quiet();
}

async function assertEqual<T>(name: string, actual: T, expected: T) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`);
}

async function waitForReady() {
  const statuses: Array<{ status: number; body: unknown }> = [];
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      const text = await response.text();
      let body: unknown = text;

      try {
        body = JSON.parse(text);
      } catch {
        // Keep non-JSON body for diagnostics.
      }

      statuses.push({ status: response.status, body });

      if (response.status === 200) return statuses;
    } catch {
      statuses.push({ status: 0, body: "connection failed" });
    }

    await Bun.sleep(100);
  }

  throw new Error(`ready timed out: ${JSON.stringify(statuses.at(-5))}`);
}

async function waitForCompletedReady() {
  const statuses: unknown[] = [];
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      const body = readySchema.parse(await response.json());
      statuses.push({ status: response.status, body });

      if (response.status === 200 && body.completed && body.failure === null) return body;
    } catch (error) {
      statuses.push(String(error));
    }

    await Bun.sleep(100);
  }

  throw new Error(`completed ready timed out: ${JSON.stringify(statuses.at(-5))}`);
}

async function fetchText(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();

  return { status: response.status, text };
}

async function main() {
  const createdDirs: string[] = [];
  let failure: unknown;
  let cleanupFailure: unknown;

  await mkdir(sourceRoot, { recursive: true });

  for (const fixture of fixtures) {
    const sourceDir = join(sourceRoot, fixture.source);

    await mkdir(sourceDir);
    createdDirs.push(sourceDir);
    await Bun.write(
      join(sourceDir, "01.mp3"),
      Bun.file(join(import.meta.dir, "..", "test", "fixtures", "audio", "tagged.mp3")),
    );
  }

  await compose("down", "-v").catch(() => undefined);

  try {
    await compose("up", "-d", "--build");
    const firstReadySamples = await waitForReady();
    const ready = await fetch(`${baseUrl}/ready`);
    const readyJson = readySchema.parse(await ready.json());
    await assertEqual("first ready status", ready.status, 200);
    await assertEqual("first ready available", readyJson.available, true);
    await assertEqual("first ready source", readyJson.availableFrom, "minimum-publication");

    const version = (
      await compose(
        "exec",
        "-T",
        "opml",
        "bun",
        "-e",
        'console.log((await Bun.file("node_modules/@seigiard/sync-engine/package.json").json()).version)',
      )
    ).stdout
      .toString()
      .trim();

    await assertEqual("sync-engine version", version, "0.5.2");

    const episode = await fetchText("/audiobooks/feed.xml/01.mp3");
    const rss = await fetchText("/feed.xml/feed.xml");
    const opml = await fetchText("/feed.opml");

    await assertEqual("episode status", episode.status, 200);
    await assertEqual("rss status", rss.status, 200);
    await assertEqual("opml status", opml.status, 200);

    if (!rss.text.includes("feed.xml/01.mp3")) throw new Error("RSS missed source identity");

    for (const fixture of fixtures) {
      const feed = await fetchText(fixture.publicPath);

      await assertEqual(`${fixture.source} RSS status`, feed.status, 200);

      if (!opml.text.includes(`${baseUrl}${fixture.publicPath}`))
        throw new Error(`OPML missed public reserved-name URL: ${fixture.publicPath}`);
    }

    await compose(
      "exec",
      "-T",
      "opml",
      "bun",
      "-e",
      `const path=${JSON.stringify(fixtures[0]!.dataFeed)}; const xml=await Bun.file(path).text(); await Bun.write(path, xml.replace("Test Title", "Corrupted Smoke Title"));`,
    );

    const corrupted = await fetchText(fixtures[0]!.publicPath);

    if (!corrupted.text.includes("Corrupted Smoke Title"))
      throw new Error("Forced resync precondition did not publish corruption");

    const forced = await fetch(`${baseUrl}/resync?force=1`, {
      headers: { Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` },
    });

    await assertEqual("forced resync status", forced.status, 202);
    await waitForCompletedReady();
    const repaired = await fetchText(fixtures[0]!.publicPath);

    if (!repaired.text.includes("Test Title") || repaired.text.includes("Corrupted Smoke Title"))
      throw new Error("Forced resync did not repair RSS corruption");

    const container = (await compose("ps", "-q", "opml")).stdout.toString().trim();
    const startedStop = Date.now();

    await compose("stop", "opml");

    const stopMs = Date.now() - startedStop;

    const exitCode = (
      await Bun.$`docker inspect -f {{.State.ExitCode}} ${container}`.quiet()
    ).stdout
      .toString()
      .trim();

    await assertEqual("SIGTERM exit code", exitCode, "0");

    if (stopMs > 15_000) throw new Error(`SIGTERM exceeded budget: ${stopMs}ms`);

    await compose("run", "--rm", "--no-deps", "opml", "sh", "-lc", `rm ${fixtures[0]!.dataFeed}`);

    await compose("start", "opml");
    await waitForCompletedReady();

    const restarted = await fetch(`${baseUrl}/ready`);
    const restartedJson = readySchema.parse(await restarted.json());

    await assertEqual("restart ready status", restarted.status, 200);
    await assertEqual("restart ready available", restartedJson.available, true);
    await assertEqual("restart ready source", restartedJson.availableFrom, "prior-output");

    const replayed = await fetchText(fixtures[0]!.publicPath);

    await assertEqual("restart replay RSS status", replayed.status, 200);

    if (!replayed.text.includes("feed.xml/01.mp3"))
      throw new Error("Restart replay missed RSS item");

    console.log(
      JSON.stringify(
        {
          project,
          port,
          firstReadyStatuses: firstReadySamples.map((sample) => sample.status),
          version,
          stopMs,
          exitCode,
          restartedAvailableFrom: restartedJson.availableFrom,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await compose("down", "-v");
    } catch (error) {
      cleanupFailure = error;
    }

    for (const dir of createdDirs.reverse()) {
      try {
        await rm(dir, { recursive: true });
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
  }

  if (failure) throw failure;

  if (cleanupFailure) throw cleanupFailure;
}

await main();
