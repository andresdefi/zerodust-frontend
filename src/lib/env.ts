/** True in the downloadable single-file build (vite build --mode offline) */
export const OFFLINE = import.meta.env.MODE === 'offline';

/** The site, for links out of the offline file (its own relative links would point at the disk) */
export const SITE = OFFLINE ? 'https://www.zerodust.xyz' : '';
