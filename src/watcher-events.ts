import { z } from "zod";

const baseUrl = z.url().parse(Bun.argv[2]);

const endpoint = z.enum(["books", "data"]).parse(Bun.argv[3]);

const frameSchema = z.tuple([z.string(), z.string(), z.string()]);

const decoder = new TextDecoder();

let pending = "";

let fields: string[] = [];

for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true });
  let boundary: number;

  while ((boundary = pending.indexOf("\0")) !== -1) {
    fields.push(pending.slice(0, boundary));
    pending = pending.slice(boundary + 1);

    if (fields.length !== 3) continue;
    const [parent, name, events] = frameSchema.parse(fields);
    fields = [];
    const overflow = events.includes("IN_Q_OVERFLOW");
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

if (pending.length !== 0 || fields.length !== 0) throw new Error("Incomplete watcher event frame");
