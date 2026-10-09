export const MIME_TYPES = new Map<string, string>([
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["m4b", "audio/mp4"],
  ["ogg", "audio/ogg"],
]);

export const AUDIO_EXTENSIONS = Array.from(MIME_TYPES.keys());
