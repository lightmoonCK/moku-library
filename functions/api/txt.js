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

/* 按书名（可选作者）在 Internet Archive 找最匹配的文本条目。
 * 查询只走 title 索引（快），作者匹配在本地做——creator 短语查询带标点数字会把 archive 搜索拖死。 */
async function findArchiveId(title, author, signal) {
  const cleanTitle = String(title || "").replace(/["“”]/g, "").trim();
  if (!cleanTitle) return null;

  const q = 'title:("' + cleanTitle + '") AND mediatype:(texts)';
  const link =
    "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(q) +
    "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&rows=10&page=1&output=json";

  const res = await fetch(link, { headers: UA, signal: signal, cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) return null;

  const data = await res.json();
  const docs = (data && data.response && data.response.docs) || [];
  if (!docs.length) return null;

  const pickOf = (d) => (Array.isArray(d.identifier) ? d.identifier[0] : d.identifier);
  const titleOf = (d) => String(Array.isArray(d.title) ? d.title[0] : d.title || "");
  const creatorOf = (d) => (Array.isArray(d.creator) ? d.creator : [d.creator]).filter(Boolean).join(" ");

  /* 本地打分：标题规范化一致优先；给了作者时 creator 字段要能对上（双向包含，兼容 "Yu, Dafu, 1896-1945" 这类洋格式） */
  const wantTitle = normTitle(cleanTitle);
  const wantAuthor = normTitle(String(author || "").replace(/佚名|unknown/i, ""));
  const scored = docs.map((d) => {
    let s = 0;
    if (normTitle(titleOf(d)) === wantTitle) s += 100;
    else if (normTitle(titleOf(d)).includes(wantTitle)) s += 40;
    if (wantAuthor) {
      const got = normTitle(creatorOf(d));
      if (got && (got.includes(wantAuthor) || wantAuthor.includes(got))) s += 30;
    }
    return { d: d, s: s };
  }).sort((a, b) => b.s - a.s);

  const best = scored[0];
  if (!best || best.s < 40) return null;
  return pickOf(best.d) || null;
}

/* 维基文库 / 维基百科：走 MediaWiki API 取正文并转纯文本 */
async function fetchWikiText(pageName, base, signal, followRedirects) {
  const api =
    base + "/w/api.php?action=parse&page=" + encodeURIComponent(pageName) +
    "&prop=text&format=json&formatversion=2&redirects=" + (followRedirects === false ? "0" : "1");
  const res = await fetch(api, { headers: UA, signal: signal, cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) return null;

  const data = await res.json();
  const html = (data && data.parse && data.parse.text) || "";
  if (!html) return null;
  return stripToText(html);
}

/* 按书名在中文维基文库找页面：先用 converttitles 做简繁标题精确转换，再用搜索严格匹配。
 * 宁可返回 null 落回 archive.org，也不能拿相关度第一的错页面（如搜"狂人日记"给《呐喊》自序）。 */
async function searchWikisourcePage(title, signal) {
  const clean = String(title || "").replace(/["“”]/g, "").trim();
  if (!clean) return null;

  /* 1. 精确：converttitles 会把简体标题转成繁体并解析重定向，命中即有 pageid */
  try {
    const exactApi =
      "https://zh.wikisource.org/w/api.php?action=query&titles=" + encodeURIComponent(clean) +
      "&converttitles=1&redirects=1&format=json";
    const res = await fetch(exactApi, { headers: UA, signal: signal, cf: { cacheTtl: 3600, cacheEverything: true } });
    if (res.ok) {
      const data = await res.json();
      const pages = (data && data.query && data.query.pages) || {};
      const hit = Object.keys(pages)
        .map((k) => pages[k])
        .find((p) => p.missing == null && p.pageid != null && (p.ns === 0 || p.ns == null));
      if (hit && hit.title) return hit.title;
    }
  } catch (e) { /* 落入搜索兜底 */ }

  /* 2. 搜索兜底：只接受标题与书名互相包含的强匹配，不用相关度第一 */
  try {
    const searchApi =
      "https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch=" + encodeURIComponent(clean) +
      "&srnamespace=0&srlimit=8&format=json";
    const res = await fetch(searchApi, { headers: UA, signal: signal, cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return null;
    const data = await res.json();
    const hits = (data && data.query && data.query.search) || [];
    const want = normTitle(clean);
    const strong = hits.find((h) => {
      const got = normTitle(h.title);
      return got === want || (got.length >= 2 && want.includes(got)) || (want.length >= 2 && got.includes(want));
    });
    return strong && strong.title ? strong.title : null;
  } catch (e) {
    return null;
  }
}

function stripToText(html) {
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+class="[^"]*(?:ws-noexport|noprint|mw-editsection)[^"]*"[^>]*>[\s\S]*?<\/(?:div|span|table)>/gi, "")
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

/* 给上游调用加独立时限：挂起的请求到点返回 fallback，保证 Function 一定有响应，不拖死连接 */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
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

/* 边下边发：上游第一个字节到达就转发给用户，不必等整份文件读完。
 * 同时先缓冲开头约 4000 字做质量抽查——扫描件 OCR 失败时正文全是 □，必须拦下。 */
async function streamText(upstream, source) {
  if (!upstream.body) return { response: null, garbage: false };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const buffered = [];
  let head = "";

  while (head.length < 4000) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered.push(chunk.value);
    head += decoder.decode(chunk.value, { stream: true });
  }

  const boxes = (head.match(/[\u25A1\u25A0\uFFFD]/g) || []).length;
  const han = (head.match(/[\u4e00-\u9fff]/g) || []).length;
  if (head.length >= 500 && boxes > 50 && boxes > han * 2) {
    return { response: null, garbage: true };
  }

  let first = true;
  const body = new ReadableStream({
    start(ctrl) {
      buffered.forEach((chunk) => {
        if (first) {
          first = false;
          /* 去掉 UTF-8 BOM，避免正文首字符变成乱码方块 */
          if (chunk.length >= 3 && chunk[0] === 0xEF && chunk[1] === 0xBB && chunk[2] === 0xBF) {
            chunk = chunk.subarray(3);
          }
        }
        ctrl.enqueue(chunk);
      });
    },
    async pull(ctrl) {
      const chunk = await reader.read();
      if (chunk.done) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(chunk.value);
    },
    cancel(reason) {
      reader.cancel(reason);
    }
  });

  return {
    garbage: false,
    response: new Response(body, {
      status: 200,
      headers: Object.assign({}, CORS, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=86400",
        "x-moku-source": source
      })
    })
  };
}

/* 显式声明了非 UTF-8 编码时才需要整体解码；其余情况直接流式转发 */
function needsFullDecode(contentType) {
  const match = /charset=([a-z0-9_-]+)/i.exec(contentType || "");
  if (!match) return false;
  return !/^utf-?8$/i.test(match[1]);
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("u");
  const title = url.searchParams.get("title");
  const author = url.searchParams.get("author") || "";

  if (!raw && !title) return fail("missing u or title", 400);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  const doFetch = (link) =>
    fetch(link, {
      headers: Object.assign({ accept: "text/plain,*/*;q=0.8" }, UA),
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 3600, cacheEverything: true }
    });

  try {
    /* ---------- 模式一：没有正文地址，按书名兜底检索（archive.org 单行本优先，维基文库做后路） ---------- */
    if (!raw && title) {
      const id = await withTimeout(findArchiveId(title, author, controller.signal), 12000, null);
      if (id) {
        const real = await withTimeout(resolveArchiveText(id, controller.signal), 8000, null);
        const link = real || "https://archive.org/download/" + encodeURIComponent(id) + "/" + encodeURIComponent(id) + "_djvu.txt";
        const res = await withTimeout(doFetch(link), 15000, null).catch(() => null);
        if (res && res.ok) {
          const type = res.headers.get("content-type") || "";
          const declared = Number(res.headers.get("content-length") || 0);
          const plain = !/json|html/i.test(type) && declared <= MAX_BYTES;
          let garbled = false;

          if (plain && !needsFullDecode(type)) {
            const checked = await streamText(res, "archive.org");
            if (checked.response) return checked.response;
            garbled = checked.garbage;
          }

          if (plain && !garbled) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength > MAX_BYTES) return fail("file too large", 413);
            const text = decode(buf, type)
              .replace(/^﻿/, "")
              .replace(/\r\n?/g, "\n");
            return textResponse(text, "archive.org");
          }
        }
      }

      /* archive 没有时落回维基文库；不跟随重定向，避免把集子页/目录页当正文（如《狂人日記》→《吶喊》） */
      const page = await withTimeout(searchWikisourcePage(title, controller.signal), 10000, null);
      if (page) {
        const wikiText = await withTimeout(fetchWikiText(page, "https://zh.wikisource.org", controller.signal, false), 12000, null);
        if (wikiText && wikiText.length > 1000) return textResponse(wikiText, "zh.wikisource.org");
      }

      return fail("no fulltext found", 404);
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

    /* 先流式转发；非 UTF-8 明码声明时才退回整体解码。首块抽查可拦下 OCR 失败的扫描件 */
    const checked = needsFullDecode(type)
      ? { response: null, garbage: false }
      : await streamText(upstream, target.hostname);
    if (checked.response) return checked.response;

    if (checked.garbage) {
      const fallback = await withTimeout(searchWikisourcePage(title, controller.signal), 10000, null);
      if (fallback) {
        const wikiText = await withTimeout(fetchWikiText(fallback, "https://zh.wikisource.org", controller.signal, false), 12000, null);
        if (wikiText && wikiText.length > 1000) return textResponse(wikiText, "zh.wikisource.org");
      }
      return fail("该扫描件未能识别出可读文本，暂无可用全文", 422);
    }

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
