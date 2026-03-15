export interface PodcastInfo {
  title: string;
  author?: string;
  description?: string;
  imageUrl?: string;
  link?: string;
  selfUrl?: string;
}

export interface EpisodeInfo {
  title: string;
  guid: string;
  pubDate: string;
  enclosureUrl: string;
  enclosureLength: number;
  enclosureType: string;
  duration?: number;
  episodeNumber: number;
}

export interface OpmlOutline {
  title: string;
  feedUrl: string;
  htmlUrl?: string;
  author?: string;
  imageUrl?: string;
  description?: string;
}
