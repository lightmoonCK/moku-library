/* 墨库 · 书源聚合检索（Cloudflare Pages Functions）
 * 路由：GET /api/search?q=关键词
 * 并行请求 Project Gutenberg / Open Library / Internet Archive / Google Books，
 * 归一化字段、按书名+作者去重合并，任何单一书源超时或报错都不影响整体结果。
 */

const SOURCE_META = {
  gutenberg: { name: "Project Gutenberg", site: "https://www.gutenberg.org" },
  openlibrary: { name: "Open Library", site: "https://openlibrary.org" },
  archive: { name: "Internet Archive", site: "https://archive.org" },
  wikisource: { name: "中文维基文库", site: "https://zh.wikisource.org" },
  googlebooks: { name: "Google Books", site: "https://books.google.com" }
};

const UA = {
  "user-agent": "MokuLibrary/1.0 (+https://moku-library.pages.dev)",
  accept: "application/json,text/plain;q=0.9,*/*;q=0.8"
};

/* 书源原始分类 → 站内统一分类 */
const CAT_RULES = [
  ["童书", /juvenile|children|少儿|儿童|童书|picture book/i],
  ["科幻", /science fiction|sci-?fi|科幻|space opera|硬科幻|星际/i],
  ["玄幻", /fantasy|玄幻|仙侠|武侠|修仙/i],
  ["悬疑", /mystery|thriller|detective|crime|悬疑|推理|侦探|惊悚/i],
  ["历史", /history|historical|historical fiction|历史|史料|传记|biography|memoir/i],
  ["社科", /social|sociology|politic|econom|philosoph|psycholog|religion|社科|社会|经济|哲学|心理|宗教|政治|法律/i],
  ["文学", /literature|literary|poetry|fiction|essay|novel|文学|小说|散文|诗歌|随笔|名著/i],
  ["艺术", /art|music|design|photograph|艺术|音乐|设计|摄影|绘画/i],
  ["科技", /science|technolog|computer|engineering|mathematic|medic|科学|技术|计算|数学|医学|工程/i]
];

function mapCat(raw) {
  const text = String(raw || "");
  for (const [name, re] of CAT_RULES) {
    if (re.test(text)) return name;
  }
  return "其他";
}

function stripHtml(str) {
  return String(str || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickYear(value) {
  const m = String(value || "").match(/(1[0-9]{3}|20[0-9]{2})/);
  return m ? Number(m[1]) : null;
}

async function getJSON(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: UA,
      signal: controller.signal,
      cf: { cacheTtl: 240, cacheEverything: true }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 单个书源适配器 ---------- */

async function searchGutenberg(q) {
  const data = await getJSON(
    "https://gutendex.com/books/?search=" + encodeURIComponent(q),
    6000
  );
  return (data.results || []).slice(0, 10).map((b) => {
    const formats = b.formats || {};
    const txtKey = Object.keys(formats).find((k) => /^text\/plain/i.test(k));
    const subjects = b.subjects || [];
    return {
      id: "gutenberg:" + b.id,
      title: b.title,
      author: (b.authors || []).map((a) => a.name).filter(Boolean).join(" / ") || "佚名",
      year: null,
      cat: mapCat(subjects.join(" ")),
      tags: subjects.slice(0, 3),
      rating: null,
      pages: null,
      popularity: b.download_count || 0,
      blurb: subjects.slice(0, 3).join(" · ") || "Project Gutenberg 收录的公共领域电子书。",
      cover: formats["image/jpeg"] ? String(formats["image/jpeg"]).replace(/^http:/, "https:") : null,
      txt: txtKey ? String(formats[txtKey]).replace(/^http:/, "https:") : null,
      link: "https://www.gutenberg.org/ebooks/" + b.id,
      source: SOURCE_META.gutenberg
    };
  });
}

async function searchOpenLibrary(q) {
  const fields = [
    "key", "title", "author_name", "first_publish_year", "cover_i", "subject",
    "edition_count", "ia", "number_of_pages_median", "language", "publisher",
    "ratings_average", "ratings_count", "first_sentence"
  ].join(",");
  const base = "https://openlibrary.org/search.json?limit=10&fields=" + fields;
  let data;
  try {
    data = await getJSON(base + "&q=" + encodeURIComponent(q), 6500);
  } catch (e) {
    /* OL 对 2 字中文等短查询的 q= 通道直接 422（与 fields 无关，去掉 fields 一样 422）。
     * 改走 title=/author= 参数通道重试，字段保持完整；两条都拿不到才放弃 */
    if (!/HTTP 422/.test(String((e && e.message) || ""))) throw e;
    const tries = await Promise.all([
      getJSON(base + "&title=" + encodeURIComponent(q), 6000).catch(() => null),
      getJSON(base + "&author=" + encodeURIComponent(q), 6000).catch(() => null)
    ]);
    const docs = tries.reduce((acc, d) => acc.concat((d && d.docs) || []), []);
    if (!docs.length) throw e;
    data = { docs: docs };
  }
  return (data.docs || []).map((d) => {
    const ia = Array.isArray(d.ia) ? d.ia[0] : null;
    const subjects = d.subject || [];
    const firstSentence = Array.isArray(d.first_sentence) ? d.first_sentence[0] : d.first_sentence;
    return {
      id: "ol:" + String(d.key || "").replace("/works/", ""),
      title: d.title,
      author: (d.author_name || []).join(" / ") || "佚名",
      year: d.first_publish_year || null,
      cat: mapCat(subjects.slice(0, 5).join(" ")),
      tags: subjects.slice(0, 3),
      /* Open Library 评分是 5 分制，统一换算成站内 10 分制 */
      rating: d.ratings_average ? Math.round(d.ratings_average * 20) / 10 : null,
      pages: d.number_of_pages_median || null,
      popularity: d.ratings_count || d.edition_count || 0,
      blurb: String(firstSentence || "").trim() || subjects.slice(0, 4).join(" · ") || "Open Library 收录的书目条目。",
      cover: d.cover_i ? "https://covers.openlibrary.org/b/id/" + d.cover_i + "-M.jpg" : null,
      txt: ia ? "https://archive.org/download/" + ia + "/" + ia + "_djvu.txt" : null,
      link: "https://openlibrary.org" + (d.key || ""),
      source: SOURCE_META.openlibrary
    };
  });
}

/* 「CWFAP 中文网络小说存档计划」在 archive 上批量灌了几十万条番茄小说网文，
 * 标题经常正好包含你要的书名（搜「沉沦」命中的《甘心沉沦》《无意沉沦》），
 * 会把真正的书目整个挤掉，检索时直接剔除。 */
const ARCHIVE_JUNK = /CWFAP|中文网络小说存档计划|番茄小说|网络小说存档|起点中文/i;

async function searchArchive(q) {
  /* 只按书名/作者检索：archive 的全文匹配会把任何正文里出现过关键词的条目都带出来 */
  const phrase = '"' + q.replace(/"/g, "") + '"';
  const query = "(title:(" + phrase + ") OR creator:(" + phrase + ")) AND mediatype:(texts)";
  const fl = ["identifier", "title", "creator", "year", "language", "downloads", "subject"]
    .map((f) => "fl%5B%5D=" + f)
    .join("&");
  const data = await getJSON(
    "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(query) + "&" + fl +
    "&rows=30&page=1&output=json",
    7000
  );
  const rawDocs = (data && data.response && data.response.docs) || [];
  const docs = rawDocs.filter((d) => !ARCHIVE_JUNK.test([].concat(d.subject || [], d.collection || []).join(" ")));

  const nq = norm(q);
  return docs.map((d) => {
    const id = d.identifier;
    const creator = Array.isArray(d.creator) ? d.creator.join(" / ") : d.creator;
    const subjects = Array.isArray(d.subject) ? d.subject : d.subject ? [d.subject] : [];
    const year = Array.isArray(d.year) ? d.year[0] : d.year;
    return {
      id: "ia:" + id,
      title: Array.isArray(d.title) ? d.title[0] : d.title,
      author: creator || "佚名",
      year: pickYear(year),
      cat: mapCat(subjects.join(" ")),
      tags: subjects.slice(0, 3),
      rating: null,
      pages: null,
      popularity: Number(d.downloads) || 0,
      blurb: subjects.slice(0, 4).join(" · ") || "Internet Archive 扫描本，提供 OCR 全文。",
      cover: "https://archive.org/services/img/" + id,
      txt: "https://archive.org/download/" + id + "/" + id + "_djvu.txt",
      link: "https://archive.org/details/" + id,
      source: SOURCE_META.archive
    };
  }).sort((a, b) => {
    /* archive 自己的排序看下载量，会把书名更长的杂项排前面；这里按书名贴近程度重排 */
    const ta = norm(a.title);
    const tb = norm(b.title);
    const ea = ta === nq ? 2 : ta.includes(nq) ? 1 : 0;
    const eb = tb === nq ? 2 : tb.includes(nq) ? 1 : 0;
    if (eb !== ea) return eb - ea;
    if (ta.length !== tb.length) return ta.length - tb.length;
    return (b.popularity || 0) - (a.popularity || 0);
  }).slice(0, 10);
}

async function searchWikisource(q) {
  /* 只按标题检索：维基文库默认是全库全文检索，会把判决书、集子章节等正文里含关键词的页面全翻出来，
   * 对书库毫无意义。intitle: 限定后结果都是书名级页面。 */
  let data = await getJSON(
    "https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch=" +
      encodeURIComponent("intitle:" + q) + "&srlimit=8&srnamespace=0&variant=zh-cn&format=json&formatversion=2",
    6000
  );
  let hits = (data && data.query && data.query.search) || [];

  /* 标题检索无结果时退回全文检索，但仍过滤掉非书籍类页面 */
  if (!hits.length) {
    data = await getJSON(
      "https://zh.wikisource.org/w/api.php?action=query&list=search&srsearch=" +
        encodeURIComponent(q) + "&srlimit=8&srnamespace=0&variant=zh-cn&format=json&formatversion=2",
      6000
    );
    hits = (data && data.query && data.query.search) || [];
  }

  const NOT_A_BOOK = /判决书|裁定书|通知书|决定书|公告|条例|实施办法|批复|复函|会议纪要/;

  return hits
    .filter((h) => h && h.title)
    /* 子页面（如《死魂靈/第一部/第六章》）和判决书类文书不是书，直接剔除 */
    .filter((h) => !/[\/／]/.test(h.title) && !NOT_A_BOOK.test(h.title))
    .map((h) => {
      /* 《銀灰色的死 (郁達夫)》 → 书名、作者分开 */
      let title = h.title;
      let author = "佚名";
      const m = /^(.+?)\s*[（(]([^）)]{2,12})[）)]$/.exec(h.title);
      if (m && !/\d/.test(m[2])) {
        title = m[1].trim();
        author = m[2].trim();
      }

      const snippet = stripHtml(h.snippet).replace(/…+/g, "…");
      const link = "https://zh.wikisource.org/wiki/" + encodeURIComponent(h.title);
      return {
        id: "ws:" + h.title,
        title: title,
        author: author,
        year: null,
        cat: mapCat(title + " " + snippet),
        tags: [],
        rating: null,
        pages: null,
        popularity: Number(h.size) || 0,
        blurb: snippet || "中文维基文库收录的公共领域文献，可直接下载全文。",
        cover: null,
        txt: link,
        link: link,
        source: SOURCE_META.wikisource
      };
    });
}

async function searchGoogleBooks(q, key) {
  let url = "https://www.googleapis.com/books/v1/volumes?q=" +
    encodeURIComponent(q) + "&maxResults=10&printType=books";
  if (key) url += "&key=" + encodeURIComponent(key);
  const data = await getJSON(url, 6000);
  return (data.items || []).map((item) => {
    const v = item.volumeInfo || {};
    const links = v.imageLinks || {};
    const cover = links.thumbnail || links.smallThumbnail || null;
    return {
      id: "gb:" + item.id,
      title: v.title || "",
      author: (v.authors || []).join(" / ") || "佚名",
      year: pickYear(v.publishedDate),
      cat: mapCat((v.categories || []).join(" ")),
      tags: (v.categories || []).slice(0, 3),
      rating: v.averageRating ? Math.round(v.averageRating * 20) / 10 : null,
      pages: v.pageCount || null,
      popularity: v.ratingsCount || 0,
      blurb: stripHtml(v.description) || "Google Books 收录书目。",
      cover: cover ? String(cover).replace(/^http:/, "https:") : null,
      txt: null,
      link: v.infoLink || v.previewLink || null,
      source: SOURCE_META.googlebooks
    };
  });
}

/* ---------- 合并去重 ---------- */

const norm = (s) => String(s || "")
  .toLowerCase()
  .replace(/[《》「」『』〈〉【】_\-—·:：,，.。!！?？'"“”‘’()（）\[\]【】]/g, "")
  .replace(/\s+/g, "");

function mergeKey(book) {
  const title = norm(book.title);
  if (!title) return "";
  const author = norm(book.author).replace(/佚名|unknown|佚名作者/g, "");
  return title + "|" + author.slice(0, 6);
}

/* 相关度：标题命中 > 作者命中 > 标签/简介命中 */
function relevanceOf(book, q) {
  const nq = norm(q);
  if (!nq) return 0;
  const title = norm(book.title);
  const author = norm(book.author);
  if (title === nq) return 8;
  if (title.includes(nq)) return 6;
  if (author.includes(nq)) return 4;
  if (norm((book.tags || []).join(" ")).includes(nq)) return 2;
  if (norm(book.blurb).includes(nq)) return 1;
  return 0;
}

function mergeAll(list) {
  const map = new Map();
  list.forEach((book) => {
    if (!book || !book.title) return;
    const key = mergeKey(book);
    if (!key) return;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, Object.assign({}, book, {
        sources: [book.source],
        source: undefined
      }));
      return;
    }
    prev.rating = prev.rating == null ? book.rating : prev.rating;
    prev.pages = prev.pages || book.pages;
    prev.year = prev.year || book.year;
    prev.cover = prev.cover || book.cover;
    prev.txt = prev.txt || book.txt;
    prev.link = prev.link || book.link;
    prev.popularity = Math.max(prev.popularity || 0, book.popularity || 0);
    if ((book.blurb || "").length > (prev.blurb || "").length) prev.blurb = book.blurb;
    if (book.tags && book.tags.length) {
      prev.tags = Array.from(new Set([].concat(prev.tags || [], book.tags))).slice(0, 4);
    }
    if (book.cat !== "其他" && prev.cat === "其他") prev.cat = book.cat;
    if (!prev.sources.some((s) => s.name === book.source.name)) prev.sources.push(book.source);
  });
  return Array.from(map.values());
}

/* ---------- 响应 ---------- */

const CORS = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8"
};

function json(body, status, maxAge) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({}, CORS, {
      "cache-control": "public, max-age=" + (maxAge || 0)
    })
  });
}

export async function onRequestGet(context) {
  const request = context.request;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 64);

  if (!q) return json({ error: "missing q" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });

  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (e) { /* cache 不可用时忽略 */ }

  const started = Date.now();
  const key = (context.env && context.env.GOOGLE_BOOKS_KEY) || "";

  const tasks = [
    ["gutenberg", () => searchGutenberg(q)],
    ["openlibrary", () => searchOpenLibrary(q)],
    ["archive", () => searchArchive(q)],
    ["wikisource", () => searchWikisource(q)],
    ["googlebooks", () => searchGoogleBooks(q, key)]
  ];

  const settled = await Promise.allSettled(
    tasks.map(([, run]) => run().then((books) => ({ books: books })))
  );

  const reports = [];
  const collected = [];

  settled.forEach((result, index) => {
    const id = tasks[index][0];
    const meta = SOURCE_META[id];
    if (result.status === "fulfilled") {
      const books = result.value.books || [];
      collected.push.apply(collected, books);
      reports.push({ id: id, name: meta.name, site: meta.site, status: "ok", count: books.length });
    } else {
      const message = String((result.reason && result.reason.message) || "failed");
      let status = "error";
      if (/abort|timeout/i.test(message)) status = "timeout";
      else if (/HTTP 429/.test(message)) status = "quota";
      reports.push({ id: id, name: meta.name, site: meta.site, status: status, count: 0, error: message });
    }
  });

  const scored = mergeAll(collected).map((book) => ({ book: book, score: relevanceOf(book, q) }));
  const hit = scored.filter((it) => it.score > 0);
  /* 相关结果足够多时，丢掉完全不相关的条目，避免长尾书把列表占满 */
  const pool = hit.length >= 6 ? hit : scored;
  const books = pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = a.book.rating == null ? -1 : a.book.rating;
    const rb = b.book.rating == null ? -1 : b.book.rating;
    if (rb !== ra) return rb - ra;
    return (b.book.popularity || 0) - (a.book.popularity || 0);
  }).map((it) => it.book);

  const payload = {
    query: q,
    took: Math.max(1, Math.round((Date.now() - started) / 10)) / 100,
    sources: reports,
    total: books.length,
    books: books.slice(0, 32)
  };

  const response = json(payload, 200, 240);
  try {
    await cache.put(cacheKey, response.clone());
  } catch (e) { /* 忽略缓存写入失败 */ }
  return response;
}
