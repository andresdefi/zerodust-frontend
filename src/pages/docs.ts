// Developer docs: content/docs/*.md rendered to HTML at build time (server
// build only; nothing here ships to the browser). Raw HTML in the Markdown is
// escaped, so a content file cannot put markup or script on a page.
import { Marked } from 'marked';

const FILES = import.meta.glob<string>('../../content/docs/*.md', { eager: true, query: '?raw', import: 'default' });
const LEGAL = import.meta.glob<string>('../../content/legal/*.md', { eager: true, query: '?raw', import: 'default' });

/** Terms and privacy (content/legal), rendered with the same rules */
export function renderLegal(name: 'terms' | 'privacy'): { title: string; html: string } {
  const source = LEGAL[`../../content/legal/${name}.md`];
  if (source === undefined) throw new Error(`legal: content/legal/${name}.md is missing`);
  return { title: source.match(/^# (.+)$/m)?.[1]?.trim() ?? name, html: renderMarkdown(source) };
}

/** Sidebar order and labels; a file not listed here is not published */
export const DOC_NAV: Array<{ slug: string; label: string; group: string }> = [
  { slug: 'index', label: 'Overview', group: 'Start' },
  { slug: 'getting-started', label: 'Getting started', group: 'Start' },
  { slug: 'sdk', label: 'SDK', group: 'SDK' },
  { slug: 'sdk-agent', label: 'Agent', group: 'SDK' },
  { slug: 'sdk-client', label: 'API client', group: 'SDK' },
  { slug: 'sdk-errors', label: 'Errors', group: 'SDK' },
  { slug: 'api', label: 'REST API', group: 'API' },
  { slug: 'direct-chains', label: 'Direct chains', group: 'API' },
  { slug: 'mcp', label: 'MCP server', group: 'AI agents' },
  { slug: 'ai-sdk', label: 'Vercel AI SDK', group: 'AI agents' },
  { slug: 'langchain', label: 'LangChain', group: 'AI agents' },
];

/** "API keys" -> "api-keys", "GET /agent/me" -> "get-agentme" */
export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    // h2 and h3 get an id from their text, so /docs/api#api-keys links work
    heading({ tokens, depth, text }) {
      const inner = this.parser.parseInline(tokens);
      if (depth < 2 || depth > 3) return `<h${depth}>${inner}</h${depth}>\n`;
      return `<h${depth} id="${slugify(text)}">${inner}</h${depth}>\n`;
    },
  },
  walkTokens(token) {
    // Links and images only to the web, the site itself, an anchor or mail: never javascript: or data:
    if ((token.type === 'link' || token.type === 'image') && !/^(https?:\/\/|\/|#|mailto:)/i.test(token.href)) {
      throw new Error(`docs: refused link "${token.href}"`);
    }
  },
});

export function docSource(slug: string): string | null {
  return FILES[`../../content/docs/${slug}.md`] ?? null;
}

/** Markdown to HTML with the rules above (raw HTML escaped, unsafe links refused) */
export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false });
}

export function renderDoc(slug: string): { title: string; html: string } {
  const source = docSource(slug);
  if (source === null) throw new Error(`docs: content/docs/${slug}.md is missing`);
  const title = source.match(/^# (.+)$/m)?.[1]?.trim() ?? slug;
  return { title, html: renderMarkdown(source) };
}

/** Where a doc is served: /docs for the overview, /docs/<slug> for the rest */
export const docPath = (slug: string) => (slug === 'index' ? '/docs' : `/docs/${slug}`);
