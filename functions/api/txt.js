/* 墨库 · 全文代理（Cloudflare Pages Functions）
 * 路由：GET /api/txt?u=原文地址
 * 只允许 Gutenberg / Internet Archive 的正文明文地址，避免变成开放代理。
 */

const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)*(archive\.org|gutenberg\.org|openlibrary\.org)$/i;
const MAX_BYTES = 18 * 1024 * 1024;

const CORS = { "access-control-allow-origin": "*" };

function fail(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status || 400,
    headers: Object.assign({}, CORS, { "content-type": "application/json; charset=utf-8" })
  });
}

function decode(buffer, contentType) {
  const match = /charset=([a-z0-9_-]+)/i.exec(contentType || "");
  const charset = match ? match[1].toLowerCase() : "utf-8";
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (e) {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("u");
  if (!raw) return fail("missing u", 400);

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return fail("bad url", 400);
  }
  if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
    return fail("host not allowed", 403);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "user-agent": "MokuLibrary/1.0 (+https://moku-library.pages.dev)",
        accept: "text/plain,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 3600, cacheEverything: true }
    });

    if (!upstream.ok) return fail("upstream " + upstream.status, 404);

    const type = upstream.headers.get("content-type") || "";
    if (/json|html/i.test(type) && !/text\/plain/i.test(type)) {
      return fail("not a plain text file", 415);
    }

    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) return fail("file too large", 413);

    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) return fail("file too large", 413);

    let text = decode(buffer, type)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n");

    return new Response(text, {
      status: 200,
      headers: Object.assign({}, CORS, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-moku-source": target.hostname
      })
    });
  } catch (e) {
    const message = String((e && e.message) || "fetch failed");
    return fail(/abort|timeout/i.test(message) ? "upstream timeout" : message, 502);
  } finally {
    clearTimeout(timer);
  }
}
