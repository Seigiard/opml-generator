declare const layout: {
  cacheUri(uri: string): string;
  cachePath(root: string, logical: string): string;
  decodeRelative(path: string): string;
  isContainer(path: string): boolean;
};

export default layout;
