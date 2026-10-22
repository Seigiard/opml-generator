import { Schema } from "effect";
import { isAbsolute } from "node:path";

const urlSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      try {
        new URL(value);

        return undefined;
      } catch {
        return "Invalid URL";
      }
    }),
  ),
);

const baseUrl = Schema.decodeUnknownSync(urlSchema)(Bun.argv[2]);

Schema.decodeUnknownSync(Schema.Literals(["books"]))(Bun.argv[3]);

const groupId = Schema.decodeUnknownSync(
  Schema.optional(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
  ),
)(Bun.argv[4]);

const eventToken = Schema.Literals([
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

const nameSchema = Schema.String.pipe(
  Schema.check(Schema.makeFilter((name) => (!name.includes("/") ? undefined : "Invalid name"))),
);

const eventsSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((events) => {
      if (events.length === 0 || events === "ISDIR") return "Invalid events";

      return events.split(",").every((token) => Schema.is(eventToken)(token))
        ? undefined
        : "Invalid events";
    }),
  ),
);

const frameSchema = Schema.Tuple([Schema.String, nameSchema, eventsSchema]).pipe(
  Schema.check(
    Schema.makeFilter(([parent, , events]) =>
      events.split(",").includes("Q_OVERFLOW") || (isAbsolute(parent) && parent.endsWith("/"))
        ? undefined
        : "Invalid parent",
    ),
  ),
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
      const [parent, name, events] = Schema.decodeUnknownSync(frameSchema)(fields);
      fields = [];
      const overflow = events.split(",").includes("Q_OVERFLOW");

      const body = overflow ? "" : JSON.stringify({ parent, name, events });
      const url = overflow ? `${baseUrl}/resync?force=1` : `${baseUrl}/events/books`;

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
