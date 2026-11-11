// A reduced Sieve proxy for Cloudflare Workers: it forwards Anthropic- and OpenAI-shaped requests and
// trims long tool descriptions. It does NOT fold or archive tool results, add cache marks, or enforce
// budgets: those need Sieve's archive and database, which a Worker does not have. Not run by Sieve's
// tests; treat it as a starting point.
const TRIM = (env) => Number(env.TRIM_BYTES || 1500);

function trim(desc, max, name) {
  if (typeof desc !== "string" || new TextEncoder().encode(desc).length <= max) return desc;
  const suffix = ` […] (full text: sieve_schema {"tool":${JSON.stringify(name)}})`;
  let head = desc.slice(0, Math.max(100, max - suffix.length));
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (cut > head.length * 0.4) head = head.slice(0, cut + 1);
  return head.trimEnd() + suffix;
}

function transform(body, max) {
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t && typeof t.name === "string" && t.description) t.description = trim(t.description, max, t.name);
    if (t?.function?.description) t.function.description = trim(t.function.description, max, t.function.name);
  }
  return body;
}

export default {
  async fetch(request, env) {
    if (env.PROXY_TOKEN && request.headers.get("x-sieve-token") !== env.PROXY_TOKEN)
      return new Response("unauthorized", { status: 401 });
    const url = new URL(request.url);
    const anthropic = url.pathname === "/v1/messages";
    const openai = url.pathname === "/v1/chat/completions";
    if (request.method !== "POST" || !(anthropic || openai))
      return new Response("not found", { status: 404 });
    const upstream = new URL(url.pathname, anthropic ? env.ANTHROPIC_UPSTREAM : env.OPENAI_UPSTREAM);
    const headers = new Headers(request.headers);
    headers.delete("x-sieve-token");
    headers.delete("host");
    let body = await request.text();
    try {
      body = JSON.stringify(transform(JSON.parse(body), TRIM(env))); // fail open: on any error send the original
    } catch {}
    return fetch(upstream, { method: "POST", headers, body });
  },
};
