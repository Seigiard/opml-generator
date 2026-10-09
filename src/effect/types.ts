export interface RawBooksEvent {
  parent: string;
  name: string;
  events: string;
}

export type EventType =
  | { _tag: "SourcePathSyncRequested"; path: string; isDirectory: boolean }
  | { _tag: "AudioFileCreated"; parent: string; name: string }
  | { _tag: "AudioFileDeleted"; parent: string; name: string }
  | { _tag: "FolderDeleted"; parent: string; name: string }
  | { _tag: "FolderMetaSyncRequested"; path: string };
