// Offline build: the logos travel inside the file as data: URIs
const LOGOS = import.meta.glob<string>('../../public/chains/*.svg', { eager: true, query: '?url', import: 'default' });
const byId = new Map(Object.entries(LOGOS).map(([path, url]) => [Number(path.match(/(\d+)\.svg$/)![1]), url]));

export function logoSrc(chainId: number): string {
  return byId.get(chainId) ?? '';
}
