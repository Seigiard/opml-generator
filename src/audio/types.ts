export interface AudioMetadata {
  title: string;
  artist?: string;
  album?: string;
  discNumber?: number;
  trackNumber?: number;
  duration?: number;
  date?: string;
  genre?: string;
}

export interface CoverArt {
  data: Buffer;
  format: string;
}
