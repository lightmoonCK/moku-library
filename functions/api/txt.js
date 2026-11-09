/* 墨库 · 全文代理（Cloudflare Pages Functions）
 * 路由：GET /api/txt?u=原文地址
 *      GET /api/txt?title=书名&author=作者   （没有直接正文地址时，按书名去 Internet Archive 兜底检索）
 * 只允许 Gutenberg / Internet Archive / Open Library / 维基文库的正文地址，避免变成开放代理。
 */

const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)*(archive\.org|gutenberg\.org|openlibrary\.org|wikisource\.org|wikipedia\.org)$/i;
const MAX_BYTES = 18 * 1024 * 1024;

const CORS = { "access-control-allow-origin": "*" };

const UA = { "user-agent": "MokuLibrary/1.0 (+https://moku-library.pages.dev)" };

/* archive.org 的条目正文文件名并不统一（_djvu.txt / .txt / .txt.gz），
 * 猜错文件名时会 404。这里读 metadata 接口，挑一个真实存在的正文文件。 */
async function resolveArchiveText(id, signal) {
  const meta = await fetch("https://archive.org/metadata/" + encodeURIComponent(id), {
    headers: UA,
    signal: signal,
    cf: { cacheTtl: 3600, cacheEverything: true }
  });
  if (!meta.ok) return null;

  const data = await meta.json();
  const files = (data.files || []).filter((f) => {
    const name = String(f.name || "");
    return /\.txt$/i.test(name) && !/_(meta|files|reviews|ch|scandata)/i.test(name.replace(/\.txt$/i, ""));
  });
  if (!files.length) return null;

  const scored = files
    .map((f) => ({ name: f.name, size: Number(f.size || 0) }))
    .sort((a, b) => {
      const da = /_djvu\.txt$/i.test(a.name) ? 1 : 0;
      const db = /_djvu\.txt$/i.test(b.name) ? 1 : 0;
      if (db !== da) return db - da;
      return b.size - a.size;
    });

  return "https://archive.org/download/" + encodeURIComponent(id) + "/" + encodeURIComponent(scored[0].name);
}

const normTitle = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[《》「」『』〈〉【】_\-—·:：,，.。!！?？'"“”‘’()（）\[\]\s]/g, "");

/* 按书名（可选作者）在 Internet Archive 找最匹配的文本条目 */
async function findArchiveId(title, author, signal) {
  const cleanTitle = String(title || "").replace(/["“”]/g, "").trim();
  if (!cleanTitle) return null;

  let q = 'title:("' + cleanTitle + '")';
  const cleanAuthor = String(author || "").replace(/["“”]/g, "").replace(/佚名|unknown/i, "").trim();
  if (cleanAuthor) q += ' AND creator:("' + cleanAuthor + '")';
  q += " AND mediatype:(texts)";

  const link =
    "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(q) +
    "&fl%5B%5D=identifier&fl%5B%5D=title&rows=6&page=1&output=json";

  const res = await fetch(link, { headers: UA, signal: signal, cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) return null;

  const data = await res.json();
  const docs = (data && data.response && data.response.docs) || [];
  if (!docs.length) return null;

  const pickOf = (d) => (Array.isArray(d.identifier) ? d.identifier[0] : d.identifier);
  const exact = docs.find((d) => {
    const dt = Array.isArray(d.title) ? d.title[0] : d.title;
    return normTitle(dt) === normTitle(cleanTitle);
  });
  return pickOf(exact || docs[0]) || null;
}

/* 维基文库 / 维基百科：走 MediaWiki API 取正文并转纯文本 */
async function fetchWikiText(pageName, base, signal) {
  const api =
    base + "/w/api.php?action=parse&page=" + encodeURIComponent(pageName) +
    "&prop=text&format=json&formatversion=2&redirects=1";
  const res = await fetch(api, { headers: UA, signal: signal, cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) return null;

  const data = await res.json();
  const html = (data && data.parse && data.parse.text) || "";
  if (!html) return null;
  return stripToText(html);
}

function stripToText(html) {
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|tr|h[1-6]|blockquote|section)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function textResponse(text, source) {
  return new Response(text, {
    status: 200,
    headers: Object.assign({}, CORS, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-moku-source": source
    })
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("u");
  const title = url.searchParams.get("title");
  const author = url.searchParams.get("author") || "";

  if (!raw && !title) return fail("missing u or title", 400);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  const doFetch = (link) =>
    fetch(link, {
      headers: Object.assign({ accept: "text/plain,*/*;q=0.8" }, UA),
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 3600, cacheEverything: true }
    });

  try {
    /* ---------- 模式一：没有正文地址，按书名去 IA 兜底检索 ---------- */
    if (!raw && title) {
      const id = await findArchiveId(title, author, controller.signal);
      if (!id) return fail("no fulltext found", 404);
      const real = await resolveArchiveText(id, controller.signal);
      const link = real || "https://archive.org/download/" + encodeURIComponent(id) + "/" + encodeURIComponent(id) + "_djvu.txt";
      const res = await doFetch(link);
      if (!res.ok) return fail("no fulltext found", 404);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) return fail("file too large", 413);
      const text = decode(buf, res.headers.get("content-type") || "")
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n");
      return textResponse(text, "archive.org");
    }

    /* ---------- 模式二：直接正文地址 ---------- */
    let target;
    try {
      target = new URL(raw);
    } catch (e) {
      return fail("bad url", 400);
    }
    if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
      return fail("host not allowed", 403);
    }

    /* 维基文库/维基百科：链接是 /wiki/页面名，转成 API 取纯文本 */
    if (/wikisource\.org|wikipedia\.org/i.test(target.hostname)) {
      const pageName = decodeURIComponent(target.pathname.replace(/^\/wiki\//, ""));
      const text = await fetchWikiText(pageName, target.origin, controller.signal);
      if (!text) return fail("no fulltext found", 404);
      return textResponse(text, target.hostname);
    }

    let upstream = await doFetch(target.toString());

    /* 猜的正文文件名不存在时，去 metadata 里找真实文件重试一次 */
    if (!upstream.ok && /archive\.org$/i.test(target.hostname)) {
      const matched = /^\/download\/([^/]+)\//.exec(target.pathname);
      if (matched) {
        const real = await resolveArchiveText(decodeURIComponent(matched[1]), controller.signal);
        if (real) upstream = await doFetch(real);
      }
    }

    if (!upstream.ok) return fail("upstream " + upstream.status, 404);

    const type = upstream.headers.get("content-type") || "";
    if (/json|html/i.test(type) && !/text\/plain/i.test(type)) {
      return fail("not a plain text file", 415);
    }

    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) return fail("file too large", 413);

    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) return fail("file too large", 413);

    const text = decode(buffer, type)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n");

    return textResponse(text, target.hostname);
  } catch (e) {
    const message = String((e && e.message) || "fetch failed");
    return fail(/abort|timeout/i.test(message) ? "upstream timeout" : message, 502);
  } finally {
    clearTimeout(timer);
  }
}
