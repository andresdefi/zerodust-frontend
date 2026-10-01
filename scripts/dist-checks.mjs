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
