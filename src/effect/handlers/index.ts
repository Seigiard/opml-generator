import { Effect } from "effect";
import { HandlerRegistry } from "../services.ts";
import { audioSync } from "./audio-sync.ts";
import { audioCleanup } from "./audio-cleanup.ts";
import { folderSync } from "./folder-sync.ts";
import { folderCleanup } from "./folder-cleanup.ts";
import { folderMetaSync } from "./folder-meta-sync.ts";
import { parentMetaSync } from "./parent-meta-sync.ts";
import { folderEntryXmlChanged } from "./folder-entry-xml-changed.ts";
import { opmlSync } from "./opml-sync.ts";

export const registerHandlers = Effect.gen(function* () {
  const registry = yield* HandlerRegistry;

  registry.register("AudioFileCreated", audioSync);
  registry.register("AudioFileDeleted", audioCleanup);
  registry.register("FolderCreated", folderSync);
  registry.register("FolderDeleted", folderCleanup);
  registry.register("EntryXmlChanged", parentMetaSync);
  registry.register("FolderEntryXmlChanged", folderEntryXmlChanged);
  registry.register("FolderMetaSyncRequested", folderMetaSync);
  registry.register("FeedXmlCreated", opmlSync);
  registry.register("FeedXmlDeleted", opmlSync);
});
