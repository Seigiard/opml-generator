import { join } from "node:path";

const uiDir = join(import.meta.dir, "..");

const staticDir = join(uiDir, "..", "static");

const build = await Bun.build({
  entrypoints: [join(uiDir, "app", "main.ts")],
  target: "browser",
  minify: true,
  naming: "main.js",
});

if (!build.success) {
  for (const log of build.logs) console.error(log);

  throw new Error("build:ui main.js failed");
}

await Bun.write(
  join(staticDir, "index.html"),
  await Bun.file(join(uiDir, "app", "index.html")).text(),
);

await Bun.write(join(staticDir, "main.js"), await build.outputs[0]!.text());

const style = await Bun.file(join(uiDir, "styles", "style.css")).text();

const reset = await Bun.file(join(uiDir, "styles", "reset.css")).text();

const charset = '@charset "UTF-8";\n';

await Bun.write(join(staticDir, "style.css"), `${charset}${reset}${style.replace(charset, "")}`);

console.log(`build:ui → ${staticDir}`);
