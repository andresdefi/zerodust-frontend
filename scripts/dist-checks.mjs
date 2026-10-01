/**
 * Rules every built page must follow for the site's CSP (script-src 'self',
 * style-src 'self', no inline code) and its integrity promise. Returns the
 * problems found in one HTML file; an empty list means it passes.
 */
export function checkHtml(html) {
  const problems = [];
  for (const [tag, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g).map((m) => [m[0], m[1], m[2]])) {
    const src = attrs.match(/\ssrc="([^"]+)"/)?.[1];
    if (!src) {
      if (body.trim()) problems.push(`inline script: ${tag.slice(0, 80)}`);
      else problems.push(`script without src: ${tag.slice(0, 80)}`);
      continue;
    }
    if (/^(https?:)?\/\//.test(src)) problems.push(`third-party script: ${src}`);
    if (!/\sintegrity="sha(256|384|512)-/.test(attrs)) problems.push(`script without integrity: ${src}`);
  }
  for (const [tag, attrs] of html.matchAll(/<link\b([^>]*)>/g).map((m) => [m[0], m[1]])) {
    if (!/\srel="(stylesheet|modulepreload|preload)"/.test(attrs)) continue;
    const href = attrs.match(/\shref="([^"]+)"/)?.[1] ?? '';
    if (/^(https?:)?\/\//.test(href)) problems.push(`third-party resource: ${href}`);
    if (/\srel="(stylesheet|modulepreload)"/.test(attrs) && !/\sintegrity="sha(256|384|512)-/.test(attrs)) {
      problems.push(`link without integrity: ${tag.slice(0, 80)}`);
    }
  }
  if (/<style\b/.test(html)) problems.push('inline <style> element');
  if (/\sstyle="/.test(html)) problems.push('inline style attribute');
  if (/\son[a-z]+="/i.test(html)) problems.push('inline event handler');
  return problems;
}

/** The CSP in vercel.json must keep the launch requirements */
export function checkCsp(csp) {
  const problems = [];
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
  const expect = (name, values) => {
    if (JSON.stringify(directives[name]) !== JSON.stringify(values)) problems.push(`${name} must be ${values.join(' ')}`);
  };
  expect('default-src', ["'none'"]);
  expect('script-src', ["'self'"]);
  expect('frame-ancestors', ["'none'"]);
  if (/'unsafe-(inline|eval|hashes)'|'wasm-unsafe-eval'/.test(csp)) problems.push('unsafe-* source in the CSP');
  if (/\*/.test(csp)) problems.push('wildcard source in the CSP');
  return problems;
}

/**
 * The offline file inlines its code, so it carries its own CSP <meta>:
 * default-src 'none', scripts and styles allowed only by SHA-256, and every
 * inline block's hash listed. Returns the problems found.
 */
export function checkOfflineHtml(html, sha256b64) {
  const problems = [];
  const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/g)];
  if (metas.length !== 1) return ['offline page: expected exactly one CSP meta'];
  const directives = Object.fromEntries(metas[0][1].split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
  if (JSON.stringify(directives['default-src']) !== JSON.stringify(["'none'"])) problems.push("offline page: default-src must be 'none'");
  for (const name of ['script-src', 'style-src']) {
    const sources = directives[name] ?? [];
    if (!sources.length || !sources.every((s) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(s))) problems.push(`offline page: ${name} must list only sha256 hashes`);
  }
  if (/'unsafe-|\*/.test(metas[0][1])) problems.push('offline page: unsafe or wildcard source in the CSP');
  const allowed = (name) => new Set((directives[name] ?? []).map((s) => s.slice(8, -1)));
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\ssrc=/.test(m[1])) problems.push('offline page: script loaded from a file');
    else if (!allowed('script-src').has(sha256b64(m[2]))) problems.push('offline page: inline script not allowed by the CSP');
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    if (!allowed('style-src').has(sha256b64(m[1]))) problems.push('offline page: inline style not allowed by the CSP');
  }
  if (/<link[^>]+rel="(stylesheet|modulepreload)"/.test(html)) problems.push('offline page: external stylesheet or module');
  if (/\son[a-z]+="/i.test(html)) problems.push('offline page: inline event handler');
  return problems;
}
