/** What a build publishes about itself (dist/.well-known/zerodust-build.json) */
export interface BuildRecord {
  /** SHA-256 over every file of the site except this record (scripts/hash-dist.mjs) */
  siteSha256: string;
  /** SHA-256 of the downloadable offline page */
  offlineSha256: string;
  /** The commit built, or "unknown" when the build ran without git */
  commit: string;
}

/** What the static pages are built with (the site hash is only known after them) */
export type PageBuild = Omit<BuildRecord, 'siteSha256'>;

export const OFFLINE_FILE = 'zerodust-offline.html';
