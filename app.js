/* 墨库 · 公开书源检索与 TXT 导出 */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);

  const els = {
    form: $("#searchForm"),
    input: $("#q"),
    results: $("#results"),
    resultList: $("#resultList"),
    queryText: $("#queryText"),
    summary: $("#summaryText"),
    sourceStatus: $("#sourceStatus"),
    offlineNote: $("#offlineNote"),
    filters: $("#filters"),
    filterCount: $("#filterCount"),
    toast: $("#toast"),
    toastText: $("#toastText"),
    bookModal: $("#bookModal"),
    sourcesModal: $("#sourcesModal"),
    sourceGrid: $("#sourceGrid")
  };

  /* 与 functions/api/search.js 保持一致的书源清单 */
  const SOURCE_LIST = [
    { id: "gutenberg", name: "Project Gutenberg", site: "https://www.gutenberg.org", note: "公共领域全文 · 可直接下载 TXT" },
    { id: "openlibrary", name: "Open Library", site: "https://openlibrary.org", note: "全球书目元数据 · 含评分与页数" },
    { id: "archive", name: "Internet Archive", site: "https://archive.org", note: "扫描本 OCR 全文 · 覆盖中英文" },
    { id: "wikisource", name: "中文维基文库", site: "https://zh.wikisource.org", note: "中文古籍与公版名篇全文 · 可直接下载" },
    { id: "googlebooks", name: "Google Books", site: "https://books.google.com", note: "书目、简介与读者评分" }
  ];

  const HOT = ["三体", "东野圭吾", "红楼梦", "三毛", "science fiction"];

  const state = {
    query: "",
    books: [],
    filter: "全部",
    sort: "relevance",
    current: null,
    loading: false,
    offline: false,
    status: [],
    took: 0
  };

  let toastTimer = null;
  let progressTimer = null;

  /* ---------- helpers ---------- */
  const esc = (str) =>
    String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const hashPalette = (str) => {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 8;
    return h + 1;
  };

  function toast(msg, ms) {
    els.toastText.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms || 3200);
  }

  function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  /* ---------- 数据归一化 ---------- */
  function prepareRemote(raw) {
    return {
      id: raw.id || raw.title,
      title: raw.title || "未命名",
      author: raw.author || "佚名",
      year: raw.year || null,
      cat: raw.cat || "其他",
      tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : [],
      rating: typeof raw.rating === "number" ? raw.rating : null,
      pages: raw.pages || null,
      popularity: raw.popularity || 0,
      blurb: raw.blurb || "",
      cover: raw.cover || null,
      txt: raw.txt || null,
      link: raw.link || null,
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      p: hashPalette(raw.title || ""),
      demo: false
    };
  }

  function prepareLocal(raw) {
    return {
      id: raw.id,
      title: raw.title,
      author: raw.author,
      year: raw.year || null,
      cat: raw.cat || "其他",
      tags: raw.tags || [],
      rating: typeof raw.rating === "number" ? raw.rating : null,
      pages: null,
      popularity: 0,
      blurb: raw.blurb || "",
      cover: null,
      txt: null,
      link: null,
      sources: (raw.sources || []).map((name) => ({ name: name, site: null })),
      p: raw.p || hashPalette(raw.title || ""),
      demo: true,
      related: !!raw.related
    };
  }

  /* ---------- 排序与打分 ---------- */
  const scoreOf = (book, q) => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    let s = (book.rating || 0) * 2;
    tokens.forEach((t) => {
      const title = book.title.toLowerCase();
      if (title === t) s += 90;
      else if (title.includes(t)) s += 48;
      /* 搜作者名时，作者本人的书要排在「写某某的传记」前面 */
      const authors = book.author.toLowerCase().split(/\s*[\/、,，;；]\s*/).filter(Boolean);
      if (authors.includes(t)) s += 80;
      else if (book.author.toLowerCase().includes(t)) s += 34;
      if (book.cat.toLowerCase().includes(t)) s += 20;
      if (book.tags.some((tag) => tag.toLowerCase().includes(t))) s += 14;
      if (book.year && String(book.year).includes(t)) s += 8;
    });
    if (book.txt) s += 10;
    return s;
  };

  const byRelevance = (q) => (a, b) => scoreOf(b, q) - scoreOf(a, q);
  const byRating = (a, b) => (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating);
  const byPopularity = (a, b) => (b.popularity || 0) - (a.popularity || 0);

  /* ---------- 封面 ---------- */
  function coverHTML(book, cls = "") {
    const img = book.cover
      ? `<img src="${esc(book.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : "";
    return `<div class="cover ${cls}" data-p="${book.p}">
      ${img}
      <span class="cover-title">${esc(book.title)}</span>
      <span class="cover-author">${esc(book.author)}</span>
    </div>`;
  }

  /* ---------- 检索中状态 ---------- */
  function showLoading() {
    const sk = `
      <div class="sk-row">
        <span class="sk sk-score" style="width:22px;height:10px"></span>
        <span class="sk sk-cover"></span>
        <span><span class="sk sk-title"></span><span class="sk sk-meta"></span></span>
        <span class="sk sk-score"></span>
        <span class="sk sk-btn"></span>
      </div>`;

    els.resultList.innerHTML = `
      <div class="loading">
        <div class="loading-line">
          <span class="loading-src">正在连接 ${esc(SOURCE_LIST[0].name)}…</span>
          <span class="loading-count">${SOURCE_LIST.length} 个公开书源并行检索</span>
        </div>
        <div class="loading-bar"><i></i></div>
        ${sk.repeat(4)}
      </div>`;

    let step = 0;
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      step += 1;
      const el = $(".loading-src", els.resultList);
      if (!el) return clearInterval(progressTimer);
      const src = SOURCE_LIST[step % SOURCE_LIST.length];
      el.textContent = "正在连接 " + src.name + "…";
    }, 900);
  }

  /* ---------- 结果渲染 ---------- */
  function renderSourceStatus() {
    if (!els.sourceStatus) return;
    if (!state.status.length) {
      els.sourceStatus.innerHTML = "";
      return;
    }
    els.sourceStatus.innerHTML = state.status
      .map((s) => {
        const cls = s.status === "ok" ? "is-ok" : s.status === "timeout" || s.status === "quota" ? "is-warn" : "is-off";
        const label =
          s.status === "ok" ? s.count + " 条"
            : s.status === "timeout" ? "超时"
              : s.status === "quota" ? "配额受限"
                : "不可用";
        return `<span class="src-state ${cls}"><i></i>${esc(s.name)}<em>${esc(label)}</em></span>`;
      })
      .join("");
  }

  function renderResults() {
    const matched = state.books;
    const cats = ["全部", ...Array.from(new Set(matched.map((b) => b.cat)))];

    els.filters.innerHTML = cats
      .map(
        (c) =>
          `<button type="button" class="filter-btn${c === state.filter ? " is-active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`
      )
      .join("");

    let view = state.filter === "全部" ? matched.slice() : matched.filter((b) => b.cat === state.filter);

    if (state.sort === "rating") view.sort(byRating);
    else if (state.sort === "popularity") view.sort(byPopularity);
    else view.sort(byRelevance(state.query));

    els.filterCount.textContent = `显示 ${view.length} / ${matched.length} 条`;

    if (!view.length) {
      els.resultList.innerHTML = `
        <div class="empty">
          <span class="empty-mark">空</span>
          <h3>「${esc(state.query)}」还没有落在架上</h3>
          <p>换个书名、作者，或者试试下面这些关键词。</p>
          <div class="empty-chips">
            ${HOT.map((h) => `<button type="button" data-q="${esc(h)}">${esc(h)}</button>`).join("")}
          </div>
        </div>`;
      return;
    }

    els.resultList.innerHTML = view
      .map((book, i) => {
        const idx = String(i + 1).padStart(3, "0");
        const facts = [];
        if (book.pages) facts.push(book.pages + " 页");
        facts.push(book.txt ? "可下载全文" : "可检索全文");
        facts.push(book.sources.length + " 个书源");

        const chips = book.sources.slice(0, 3)
          .map((s) => `<span class="src-chip">${esc(s.name)}</span>`)
          .join("");
        const more = book.sources.length > 3 ? `<span class="src-chip">+${book.sources.length - 3}</span>` : "";

        const ratingCell = book.rating
          ? `<b>${book.rating.toFixed(1)}</b><span>评分</span>`
          : `<b class="score-na">—</b><span>暂无评分</span>`;

        return `
        <article class="result" data-id="${esc(book.id)}" style="--i:${Math.min(i, 11)}">
          <span class="idx">${idx}</span>
          ${coverHTML(book)}
          <div class="result-info">
            <div class="r-title-row">
              <h3>${esc(book.title)}</h3>
              <span class="cat-tag">${esc(book.cat)}</span>
              ${book.related ? '<span class="rel-tag">相关</span>' : ""}
              ${book.year ? `<span class="year">${esc(book.year)}</span>` : ""}
            </div>
            <p class="result-meta">
              <b>${esc(book.author)}</b>${facts.map((f) => `<span class="dot">·</span>${esc(f)}`).join("")}
            </p>
            <div class="src-chips">${chips}${more}</div>
          </div>
          <div class="score">${ratingCell}</div>
          <div class="result-actions">
            <button type="button" class="download-btn" data-dl="${esc(book.id)}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>
              ${book.txt ? "下载 TXT" : "查找全文"}
            </button>
          </div>
        </article>`;
      })
      .join("");
  }

  function setSummary() {
    if (state.offline) {
      els.offlineNote.hidden = false;
      els.offlineNote.textContent =
        "公开书源暂时连不上（校园网 / 代理或书源限流），已切换到内置离线书架，仅供预览。";
      els.summary.textContent = `离线书架 ${state.books.length} 条演示书目 · 未连接公开书源`;
      return;
    }
    els.offlineNote.hidden = true;
    const ok = state.status.filter((s) => s.status === "ok").length;
    const fullText = state.books.filter((b) => b.txt).length;
    els.summary.textContent = `找到 ${state.books.length} 条结果 · 用时 ${state.took || 0} 秒 · ${ok} / ${state.status.length} 个书源可用${
      fullText ? ` · ${fullText} 条可下载全文` : ""
    }`;
  }

  /* ---------- 本地离线书架 ---------- */
  const SHELF = typeof BOOKS !== "undefined" && Array.isArray(BOOKS) ? BOOKS : [];

  const matchBook = (book, q) => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = [book.title, book.author, book.cat, book.year, ...(book.tags || [])].join(" ").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  };

  function searchShelf(q) {
    const direct = SHELF.filter((b) => matchBook(b, q));

    let related = [];
    if (direct.length && direct.length < 4) {
      const cats = new Set(direct.map((b) => b.cat));
      const tags = new Set(direct.flatMap((b) => b.tags || []));
      related = SHELF.filter(
        (b) => !direct.includes(b) && (cats.has(b.cat) || (b.tags || []).some((t) => tags.has(t)))
      )
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 4 - direct.length)
        .map((b) => Object.assign({}, b, { related: true }));
    }
    return direct.concat(related).map(prepareLocal);
  }

  /* ---------- 检索 ---------- */
  function scrollToResults() {
    const top = els.results.getBoundingClientRect().top + window.scrollY - 88;
    window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
  }

  function fallbackToShelf(q, reason) {
    state.offline = true;
    state.took = 0;
    state.books = searchShelf(q);
    state.status = SOURCE_LIST.map((s) => ({ id: s.id, name: s.name, status: "offline", count: 0 }));
    renderSourceStatus();
    setSummary();
    renderResults();
    if (SHELF.length) toast("公开书源不可用，已切换离线书架" + (reason ? "（" + reason + "）" : ""));
  }

  async function runSearch(raw) {
    const q = String(raw || "").trim();
    if (!q) {
      els.input.focus();
      toast("请输入书名、作者或关键词");
      return;
    }

    state.query = q;
    state.filter = "全部";
    state.sort = "relevance";
    state.books = [];
    state.status = [];
    state.offline = false;

    document.body.classList.add("has-searched");
    els.results.hidden = false;
    els.queryText.textContent = q;
    els.summary.textContent = "正在聚合检索…";
    if (els.offlineNote) els.offlineNote.hidden = true;
    if (els.sourceStatus) els.sourceStatus.innerHTML = "";

    document.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.sort === "relevance");
    });

    state.loading = true;
    showLoading();
    scrollToResults();

    clearInterval(progressTimer);

    try {
      const res = await fetchWithTimeout("/api/search?q=" + encodeURIComponent(q), 16000);
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !/json/i.test(type)) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data || !Array.isArray(data.books)) throw new Error("bad payload");

      state.books = data.books.map(prepareRemote);
      state.status = Array.isArray(data.sources) ? data.sources : [];
      state.took = data.took || 0;

      renderSourceStatus();
      setSummary();
      renderResults();

      if (!state.books.length) toast("这本书还没落在架上，换个关键词试试");

      if (location.protocol.startsWith("http")) {
        history.replaceState(null, "", "?q=" + encodeURIComponent(q));
      }
    } catch (err) {
      const reason = /abort/i.test(String(err && err.message)) ? "请求超时" : "接口不可用";
      fallbackToShelf(q, reason);
      if (!SHELF.length) {
        els.resultList.innerHTML = `
          <div class="empty">
            <span class="empty-mark">空</span>
            <h3>暂时连不上公开书源</h3>
            <p>请检查网络后重试，或稍后再来。</p>
            <div class="empty-chips">
              ${HOT.map((h) => `<button type="button" data-q="${esc(h)}">${esc(h)}</button>`).join("")}
            </div>
          </div>`;
      }
    } finally {
      state.loading = false;
    }
  }

  /* ---------- TXT ---------- */
  function saveText(text, filename) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function downloadBook(book, trigger) {
    if (!book || !trigger) return;
    const original = trigger.innerHTML;
    trigger.disabled = true;

    const setLoading = (label) => {
      trigger.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" style="animation:spin 0.9s linear infinite"><path d="M12 4a8 8 0 1 0 8 8"/></svg> ${label}`;
    };
    setLoading("生成中…");

    let text = "";
    let fullText = false;
    let viaLookup = false;
    let lastError = "";

    /* 边收边解码：配合服务端流式输出，按钮上实时显示已下载体量 */
    const tryLoad = async (qs, ms) => {
      const res = await fetchWithTimeout("/api/txt?" + qs, ms);
      const type = res.headers.get("content-type") || "";
      if (!res.ok || /html/i.test(type)) {
        /* 服务端会说明具体原因（如扫描件识别失败），记下来给用户看 */
        if (!/html/i.test(type)) {
          try {
            const data = await res.json();
            if (data && data.error) lastError = String(data.error);
          } catch (e) { /* 错误体不是 JSON 就保持静默 */ }
        }
        return "";
      }

      if (!res.body || typeof res.body.getReader !== "function") {
        const body = await res.text();
        return body.trim().length > 0 ? body : "";
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let out = "";
      let got = 0;
      let lastPaint = 0;

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        got += chunk.value.length;
        out += decoder.decode(chunk.value, { stream: true });

        const now = Date.now();
        if (now - lastPaint > 400) {
          lastPaint = now;
          setLoading("下载中 " + Math.max(1, Math.round(got / 1024)) + " KB…");
        }
      }
      out += decoder.decode();

      return out.trim().length > 0 ? out : "";
    };

    if (book.txt) {
      try {
        text = await tryLoad(
          "u=" + encodeURIComponent(book.txt) +
          "&title=" + encodeURIComponent(book.title || "") +
          "&author=" + encodeURIComponent(book.author && book.author !== "佚名" ? book.author : ""),
          40000
        );
        fullText = !!text;
      } catch (e) { /* 落入下一步兜底 */ }
    }

    /* 该书源没给正文地址时，按书名+作者去 维基文库 / Internet Archive 兜底检索全文 */
    if (!fullText && book.title) {
      setLoading("检索全文中…");
      try {
        text = await tryLoad(
          "title=" + encodeURIComponent(book.title) +
          "&author=" + encodeURIComponent(book.author && book.author !== "佚名" ? book.author : ""),
          40000
        );
        fullText = !!text;
        viaLookup = fullText;
      } catch (e) { /* 落入书目信息兜底 */ }
    }

    /* 找不到全文时不再导出书目文件，只给出明确原因 */
    if (!fullText) {
      trigger.disabled = false;
      trigger.innerHTML = original;
      toast(
        /未能识别出可读文本/.test(lastError)
          ? `《${book.title}》只有扫描件，且扫描质量太差、识别不出可读文字，已放弃下载`
          : /no fulltext found/.test(lastError)
            ? `《${book.title}》在公开书源里没有可下载的全文，只有书目信息`
            : book.txt
              ? `《${book.title}》的书源原件取不到正文，可能已下架或被限流，稍后可再试`
              : `《${book.title}》没有可下载全文：该书仍在版权保护期，公开书源只提供书目`,
        6000
      );
      return;
    }

    try {
      const name = `《${book.title}》 ${book.author} · 全文.txt`;
      saveText(text, name);
      toast(
        viaLookup
          ? `已检索到《${book.title}》全文（${Math.round(text.length / 1000)} 千字）`
          : `《${book.title}》全文 TXT 已保存（${Math.round(text.length / 1000)} 千字）`
      );
    } finally {
      trigger.disabled = false;
      trigger.innerHTML = original;
    }
  }

  /* ---------- 详情弹窗 ---------- */
  function openBook(book) {
    state.current = book;
    $("#modalCover").innerHTML = coverHTML(book);
    $("#modalCat").textContent = book.cat + (book.year ? " · " + book.year : "");
    $("#modalTitle").textContent = book.title;
    $("#modalAuthor").textContent = book.author;
    $("#modalBlurb").textContent = book.blurb || "该书源未提供简介。";
    $("#modalWords").textContent = book.pages ? book.pages + " 页" : "未提供";
    $("#modalRating").textContent = book.rating ? book.rating.toFixed(1) + " / 10" : "暂无评分";
    $("#modalSize").textContent = book.txt ? "可下载全文" : "可检索全文";
    $("#modalYear").textContent = book.year ? String(book.year) : "—";
    $("#modalSources").innerHTML = book.sources
      .map((s) =>
        s.site
          ? `<a class="src-chip src-chip-link" href="${esc(s.site)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
          : `<span class="src-chip">${esc(s.name)}</span>`
      )
      .join("");

    const link = $("#modalLink");
    if (book.link) {
      link.href = book.link;
      link.hidden = false;
    } else {
      link.hidden = true;
      link.removeAttribute("href");
    }

    const dl = $("#modalDownload");
    dl.disabled = false;
    dl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg> ${
      book.txt ? "下载 TXT 全文" : "查找全文"
    }`;

    els.bookModal.hidden = false;
    document.body.classList.add("no-scroll");
  }

  function openSources() {
    const statusById = {};
    state.status.forEach((s) => (statusById[s.id] = s.status));
    els.sourceGrid.innerHTML = SOURCE_LIST.map((s) => {
      const st = statusById[s.id];
      const cls = st === "ok" ? "" : st ? " is-off" : "";
      return `<a class="source-item${cls}" href="${esc(s.site)}" target="_blank" rel="noopener">
        <span class="source-name">${esc(s.name)}<em>${esc(s.note)}</em></span>
        <i></i>
      </a>`;
    }).join("");
    els.sourcesModal.hidden = false;
    document.body.classList.add("no-scroll");
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (!document.querySelector(".modal:not([hidden])")) {
      document.body.classList.remove("no-scroll");
    }
  }

  /* ---------- 事件 ---------- */
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(els.input.value);
  });

  document.querySelectorAll(".hot-chips button").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.input.value = btn.dataset.q;
      runSearch(btn.dataset.q);
    });
  });

  els.filters.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    state.filter = btn.dataset.cat;
    renderResults();
  });

  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      if (state.books.length) renderResults();
    });
  });

  els.resultList.addEventListener("click", (e) => {
    const dl = e.target.closest("[data-dl]");
    if (dl) {
      const book = state.books.find((b) => b.id === dl.dataset.dl);
      downloadBook(book, dl);
      return;
    }
    const emptyChip = e.target.closest(".empty-chips button");
    if (emptyChip) {
      els.input.value = emptyChip.dataset.q;
      runSearch(emptyChip.dataset.q);
      return;
    }
    const row = e.target.closest(".result");
    if (row) {
      const book = state.books.find((b) => b.id === row.dataset.id);
      if (book) openBook(book);
    }
  });

  $("#modalDownload").addEventListener("click", (e) => {
    downloadBook(state.current, e.currentTarget);
  });

  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.closest(".modal")));
  });

  $("#openSources").addEventListener("click", openSources);
  $("#footSources").addEventListener("click", openSources);

  document.addEventListener("keydown", (e) => {
    const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === "/" && !inField) {
      e.preventDefault();
      els.input.focus();
      els.input.select();
    }
    if (e.key === "Escape") {
      const open = document.querySelector(".modal:not([hidden])");
      if (open) closeModal(open);
    }
  });

  /* default state */
  const initialQ = new URLSearchParams(location.search).get("q");
  if (initialQ) {
    els.input.value = initialQ;
    setTimeout(() => runSearch(initialQ), 300);
  }
})();
