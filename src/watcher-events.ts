import { z } from "zod";
import { isAbsolute } from "node:path";

const baseUrl = z.url().parse(Bun.argv[2]);

const endpoint = z.enum(["books", "data"]).parse(Bun.argv[3]);

const groupId = z.coerce.number().int().positive().optional().parse(Bun.argv[4]);

const eventToken = z.enum([
  "ACCESS",
  "MODIFY",
  "ATTRIB",
  "CLOSE_WRITE",
  "CLOSE_NOWRITE",
  "CLOSE",
  "OPEN",
  "MOVED_FROM",
  "MOVED_TO",
  "MOVE",
  "MOVE_SELF",
  "CREATE",
  "DELETE",
  "DELETE_SELF",
  "UNMOUNT",
  "Q_OVERFLOW",
  "IGNORED",
  "ISDIR",
]);

const frameSchema = z
  .tuple([
    z.string(),
    z.string().refine((name) => !name.includes("/")),
    z
      .string()
      .refine(
        (events) =>
          events.length > 0 &&
          events.split(",").every((token) => eventToken.safeParse(token).success) &&
          events !== "ISDIR",
      ),
  ])
  .refine(
    ([parent, , events]) =>
      events.split(",").includes("Q_OVERFLOW") || (isAbsolute(parent) && parent.endsWith("/")),
  );

const decoder = new TextDecoder();

let pending = "";

let fields: string[] = [];

try {
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary: number;

    while ((boundary = pending.indexOf("\0")) !== -1) {
      fields.push(pending.slice(0, boundary));
      pending = pending.slice(boundary + 1);

      if (fields.length !== 3) continue;
      const [parent, name, events] = frameSchema.parse(fields);
      fields = [];
      const overflow = events.split(",").includes("Q_OVERFLOW");
      const body = overflow ? "" : JSON.stringify({ parent, name, events });
      const url = overflow ? `${baseUrl}/resync` : `${baseUrl}/events/${endpoint}`;

      const request = Bun.spawn(
        [
          "wget",
          "-T",
          "2",
          "-q",
          `--post-data=${body}`,
          "--header=Content-Type: application/json",
          "-O",
          "/dev/null",
          url,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );

      await request.exited;
    }
  }

  pending += decoder.decode();

  if (pending.length !== 0 || fields.length !== 0)
    throw new Error("Incomplete watcher event frame");
} catch (error) {
  console.error("Watcher framing failed", error);

  if (groupId) process.kill(-groupId, "SIGTERM");
  process.exit(1);
}
