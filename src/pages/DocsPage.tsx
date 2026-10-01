import { StaticPage } from './Layout';
import { DOC_NAV, docPath, renderDoc } from './docs';

export function DocsPage({ slug }: { slug: string }) {
  const { html } = renderDoc(slug);
  const groups = [...new Set(DOC_NAV.map((d) => d.group))];
  return (
    <StaticPage wide>
      <div className="docs">
        <nav className="docs-nav" aria-label="Docs">
          {groups.map((g) => (
            <div key={g}>
              <p className="docs-group">{g}</p>
              <ul>
                {DOC_NAV.filter((d) => d.group === g).map((d) => (
                  <li key={d.slug}>
                    <a href={docPath(d.slug)} aria-current={d.slug === slug ? 'page' : undefined}>{d.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        {/* Rendered at build time from content/docs (raw HTML escaped) */}
        <article className="doc docs-body" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </StaticPage>
  );
}
