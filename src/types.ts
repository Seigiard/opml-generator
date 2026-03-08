export interface FileInfo {
  path: string;
  relativePath: string;
  size: number;
  mtime: number;
  extension: string;
}

export interface FolderInfo {
  path: string;
  name: string;
  subfolders: string[];
  audioFileCount: number;
}

export const MIME_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  ogg: "audio/ogg",
};

export const AUDIO_EXTENSIONS = Object.keys(MIME_TYPES);
