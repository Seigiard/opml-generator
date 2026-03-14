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

  registry.registerAsync("AudioFileCreated", audioSync);
  registry.registerAsync("AudioFileDeleted", audioCleanup);
  registry.registerAsync("FolderCreated", folderSync);
  registry.registerAsync("FolderDeleted", folderCleanup);
  registry.registerAsync("EntryXmlChanged", parentMetaSync);
  registry.registerAsync("FolderEntryXmlChanged", folderEntryXmlChanged);
  registry.registerAsync("FolderMetaSyncRequested", folderMetaSync);
  registry.registerAsync("FeedXmlCreated", opmlSync);
  registry.registerAsync("FeedXmlDeleted", opmlSync);
});
