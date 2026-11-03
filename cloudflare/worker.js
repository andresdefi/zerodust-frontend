// zerodust.xyz on Cloudflare Workers (moving off Vercel). Serves dist/ and
// applies vercel.json so both hosts answer the same: trailingSlash: false,
// redirects, rewrites and headers. Headers are set here rather than in a
// _headers file because the CSP is longer than the 2000 characters a
// _headers line allows. cleanUrls is the assets' html_handling (wrangler.jsonc).
import vercel from "../vercel.json";

// Vercel patterns used in vercel.json: "/(.*)" and "/x/:name*" (zero or more segments).
const pattern = (source) =>
  new RegExp("^" + source.replace("(.*)", ".*").replace(/\/:\w+\*/g, "(?:/.*)?") + "$");

const headerRules = vercel.headers.map(({ source, headers }) => ({ test: pattern(source), headers }));
const redirects = vercel.redirects.map((r) => ({ test: pattern(r.source), to: r.destination, status: r.permanent ? 308 : 307 }));
const rewrites = vercel.rewrites.map((r) => ({ test: pattern(r.source), to: r.destination }));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // The apex redirects to www, as Vercel's domain setting did.
    if (url.hostname === "zerodust.xyz") {
      url.hostname = "www.zerodust.xyz";
      return Response.redirect(url.toString(), 308);
    }

    if (pathname.length > 1 && pathname.endsWith("/")) {
      url.pathname = pathname.replace(/\/+$/, "");
      return Response.redirect(url.toString(), 308);
    }
    const redirect = redirects.find((r) => r.test.test(pathname));
    if (redirect) {
      url.pathname = redirect.to;
      return Response.redirect(url.toString(), redirect.status);
    }
    const rewrite = rewrites.find((r) => r.test.test(pathname));
    if (rewrite) url.pathname = rewrite.to;

    const response = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(response.headers);
    for (const rule of headerRules)
      if (rule.test.test(pathname)) for (const { key, value } of rule.headers) headers.set(key, value);
    // html_handling redirects /page.html to /page with a 307; Vercel uses 308.
    const status = response.status === 307 ? 308 : response.status;
    return new Response(response.body, { status, headers });
  },
};
