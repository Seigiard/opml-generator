// Image size constants
export const COVER_MAX_SIZE = 1400;
export const THUMBNAIL_MAX_SIZE = 512;
export const COVER_MIN_DIMENSION = 500;

// File constants for the contract between Bun and nginx
// These names are used in both TypeScript code and nginx.conf.template
export const FEED_FILE = "feed.xml";
export const ENTRY_FILE = "entry.xml";
export const FOLDER_ENTRY_FILE = "_entry.xml";
export const OPML_FILE = "feed.opml";
export const COVER_FILE = "cover.jpg";
export const THUMB_FILE = "thumb.jpg";

export const COVER_FILENAMES = ["cover.jpg", "cover.png", "cover.webp", "folder.jpg", "folder.png"];
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
