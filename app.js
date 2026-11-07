/* 墨库 · 检索与 TXT 导出（纯前端演示版） */
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
    filters: $("#filters"),
    filterCount: $("#filterCount"),
    toast: $("#toast"),
    toastText: $("#toastText"),
    bookModal: $("#bookModal"),
    sourcesModal: $("#sourcesModal"),
    sourceGrid: $("#sourceGrid")
  };

  const HOT = ["三体", "东野圭吾", "明朝", "三毛", "科幻"];

  const SOURCES = [
    "豆瓣读书", "微信读书", "掌阅", "起点中文网", "晋江文学城", "纵横中文网",
    "17K小说网", "番茄小说", "知乎书单", "鸠摩搜书", "孔夫子旧书网", "超星数字图书馆",
    "中国国家数字图书馆", "书格", "古登堡计划", "互联网档案馆", "Z-Library", "书香中国",
    "京东读书", "当当云阅读", "咪咕阅读", "塔读文学", "长佩文学", "豆瓣阅读",
    "Kindle 商店", "得到", "三联中读", "理想国", "微信听书", "华为阅读",
    "百度阅读", "多看阅读", "QQ阅读", "网易云阅读", "纵横书城", "潇湘书院"
  ];
  const OFFLINE_SOURCES = ["Kindle 商店", "当当云阅读", "网易云阅读"];

  const CHAPTERS = [
    "序章", "第一章　旧事", "第二章　远行", "第三章　相遇",
    "第四章　风雨", "第五章　抉择", "第六章　归途", "尾声"
  ];

  const EXCERPTS = {
    小说: "院子里的槐树落了一地花。\n\n她坐在门槛上，把那双磨破的布鞋翻过来又翻过去，像是在数一数这些年走过的路。远处传来火车的声音，穿过麦田，穿过黄昏，穿过所有还没来得及说出口的话。\n\n“人这一辈子，能记住的其实就那么几件事。”父亲说这句话的时候，正把最后一袋粮食扛上肩。天就要黑了，炊烟一层层压下来，把整个村庄罩在一层温柔的灰里。",
    文学: "我一直记得那个下午的光。它从窗棂的缝隙里斜进来，落在旧木桌上，把灰尘照得像金色的雪。\n\n母亲在厨房里切菜，刀与砧板的声音一下一下，很稳。她说，日子就是这样，一刀一刀切下去，切到最后也就过完了。\n\n那时我还不懂这句话。后来我走得很远，在许多个陌生的房间里醒来，才慢慢明白：所谓故乡，不过是一盏总为你亮着的灯。",
    科幻: "警报在第三轮循环时才被听见。\n\n观测站浮在黑暗里，像一枚被遗忘的针。屏幕上，那颗行星的轮廓正在缓慢变化——不是自转，不是潮汐，而是一种有节奏的呼吸。\n\n“它在看我们。”值班员低声说。\n\n没有人回答。所有人都在同一时刻意识到，人类并不是这片宇宙里第一个抬头望向星空的文明，也未必是最后一个。倒计时开始了，而他们只有七十二小时来决定，要不要回应。",
    悬疑: "雨从傍晚开始下，一直没有停。\n\n现场的灯亮得刺眼，警戒线在风里轻轻晃动。她蹲下去，看见地板上那道几乎被擦掉的血痕，形状像一个没有写完的字。\n\n“三年前也是这样的天气。”同事在她身后说。\n\n她没有回头。她知道，有些案子从来没有真正结束，只是暂时安静下来，等待下一个雨夜。",
    历史: "那一年，京城下了很大的雪。\n\n年轻的官员站在午门外，把手缩进袖子里，听候传唤。他怀里揣着一份奏疏，写了整整三个月，字斟句酌，删了又改。他知道，递上去的那一刻，自己的仕途乃至性命，就都交给了一个不可预测的答案。\n\n宫门开了一条缝，内侍的声音又细又长：“宣——”\n\n他深吸一口气，雪落在肩上，很快就化了。",
    社科: "所有大规模的人类协作，最终都建立在某种共同想象之上。\n\n货币之所以有价值，不是因为金属，而是因为所有人都相信它有价值；国家之所以存在，不是因为城墙，而是因为无数人愿意承认同一条边界。\n\n当这种相信被建立起来，陌生人就能一起修路、纳税、作战、贸易。文明的力量，并不在于个体的强壮，而在于虚构故事被亿万人同时相信的程度。",
    玄幻: "山门在云上。\n\n少年背着剑，一步一步走上石阶。雾气从脚边漫过去，带着松脂和雷火的气味。他数不清走了多少级，只记得每一级台阶上都刻着一个名字，那是前人留下的路。\n\n峰顶有风。风里有声音在问他：你是谁，为何而来。\n\n他握住剑柄，答得很轻，却很稳：“我来取一个答案。”"
  };

  const state = {
    query: "",
    results: [],
    filter: "全部",
    sort: "relevance",
    current: null,
    loading: false
  };

  let loadTimer = null;
  let progressTimer = null;
  let toastTimer = null;

  /* ---------- helpers ---------- */
  const esc = (str) =>
    String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const pad2 = (n) => String(n).padStart(2, "0");

  const wordsText = (words) => (words / 10000).toFixed(1) + " 万字";

  const fileSize = (words) => {
    const kb = Math.round((words * 3.05) / 1024);
    return kb >= 1000 ? (kb / 1000).toFixed(1) + " MB" : kb + " KB";
  };

  const nowText = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  const scoreOf = (book, q) => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    let s = book.rating * 2;
    tokens.forEach((t) => {
      if (book.title.toLowerCase() === t) s += 90;
      else if (book.title.toLowerCase().includes(t)) s += 48;
      if (book.author.toLowerCase().includes(t)) s += 34;
      if (book.cat.toLowerCase().includes(t)) s += 20;
      if (book.tags.some((tag) => tag.toLowerCase().includes(t))) s += 14;
      if (String(book.year).includes(t)) s += 8;
    });
    return s;
  };

  const matchBook = (book, q) => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = [book.title, book.author, book.cat, book.year, ...book.tags].join(" ").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  };

  function toast(msg) {
    els.toastText.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2800);
  }

  function coverHTML(book, cls = "") {
    return `<div class="cover ${cls}" data-p="${book.p}">
      <span class="cover-title">${esc(book.title)}</span>
      <span class="cover-author">${esc(book.author)}</span>
    </div>`;
  }

  /* ---------- loading ---------- */
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
          <span class="loading-src">正在连接 豆瓣读书…</span>
          <span class="loading-count">已聚合 0 / 47</span>
        </div>
        <div class="loading-bar"><i></i></div>
        ${sk.repeat(4)}
      </div>`;

    let step = 0;
    const live = ["豆瓣读书", "微信读书", "起点中文网", "掌阅", "鸠摩搜书", "晋江文学城", "超星数字图书馆", "番茄小说"];
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      step += 3;
      const srcEl = $(".loading-src", els.resultList);
      const cntEl = $(".loading-count", els.resultList);
      if (!srcEl || !cntEl) return clearInterval(progressTimer);
      srcEl.textContent = "正在连接 " + live[(step / 3) % live.length] + "…";
      cntEl.textContent = `已聚合 ${Math.min(step, 47)} / 47`;
      if (step >= 47) clearInterval(progressTimer);
    }, 110);
  }

  /* ---------- render ---------- */
  function renderResults() {
    const matched = state.results;
    const cats = ["全部", ...Array.from(new Set(matched.map((b) => b.cat)))];

    els.filters.innerHTML = cats
      .map(
        (c) =>
          `<button type="button" class="filter-btn${c === state.filter ? " is-active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`
      )
      .join("");

    let view = state.filter === "全部" ? matched.slice() : matched.filter((b) => b.cat === state.filter);

    if (state.sort === "rating") view.sort((a, b) => b.rating - a.rating);
    else if (state.sort === "words") view.sort((a, b) => b.words - a.words);
    else view.sort((a, b) => scoreOf(b, state.query) - scoreOf(a, state.query));

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
        return `
        <article class="result" data-id="${esc(book.id)}" style="--i:${Math.min(i, 11)}">
          <span class="idx">${idx}</span>
          ${coverHTML(book)}
          <div class="result-info">
            <div class="r-title-row">
              <h3>${esc(book.title)}</h3>
              <span class="cat-tag">${esc(book.cat)}</span>
              ${book.related ? '<span class="rel-tag">相关</span>' : ""}
              <span class="year">${esc(book.year)}</span>
            </div>
            <p class="result-meta">
              <b>${esc(book.author)}</b><span class="dot">·</span>
              约 ${wordsText(book.words)}<span class="dot">·</span>
              TXT ${fileSize(book.words)}<span class="dot">·</span>
              ${book.sources.length} 个书源
            </p>
            <div class="src-chips">
              ${book.sources.map((s) => `<span class="src-chip">${esc(s)}</span>`).join("")}
            </div>
          </div>
          <div class="score">
            <b>${book.rating.toFixed(1)}</b>
            <span>评分</span>
          </div>
          <div class="result-actions">
            <button type="button" class="download-btn" data-dl="${esc(book.id)}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>
              下载 TXT
            </button>
          </div>
        </article>`;
      })
      .join("");
  }

  /* ---------- search ---------- */
  function scrollToResults() {
    const top = els.results.getBoundingClientRect().top + window.scrollY - 88;
    window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
  }

  function finishSearch() {
    state.loading = false;
    const q = state.query;
    const direct = BOOKS.filter((b) => matchBook(b, q));

    let related = [];
    if (direct.length && direct.length < 4) {
      const cats = new Set(direct.map((b) => b.cat));
      const tags = new Set(direct.flatMap((b) => b.tags));
      related = BOOKS.filter(
        (b) => !direct.includes(b) && (cats.has(b.cat) || b.tags.some((t) => tags.has(t)))
      )
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 4 - direct.length)
        .map((b) => Object.assign({}, b, { related: true }));
    }

    state.results = direct.concat(related);

    const sourceUsed = new Set();
    state.results.forEach((b) => b.sources.forEach((s) => sourceUsed.add(s)));

    if (state.results.length) {
      els.summary.textContent = related.length
        ? `找到 ${direct.length} 条精确结果 · 另有 ${related.length} 条相关推荐 · 用时 0.42 秒 · 来自 ${sourceUsed.size} 个书源`
        : `找到 ${state.results.length} 条结果 · 用时 0.42 秒 · 来自 ${sourceUsed.size} 个书源`;
    } else {
      els.summary.textContent = `0 条结果 · 用时 0.42 秒 · 已检索 ${SOURCES.length} 个书源`;
    }

    renderResults();
  }

  function runSearch(raw) {
    const q = raw.trim();
    if (!q) {
      els.input.focus();
      toast("请输入书名、作者或关键词");
      return;
    }

    state.query = q;
    state.filter = "全部";
    state.sort = "relevance";

    document.body.classList.add("has-searched");
    els.results.hidden = false;
    els.queryText.textContent = q;
    els.summary.textContent = "正在聚合检索…";

    document.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.sort === "relevance");
    });

    state.loading = true;
    showLoading();
    scrollToResults();

    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      clearInterval(progressTimer);
      finishSearch();
    }, 850);
  }

  /* ---------- TXT ---------- */
  function buildTxt(book) {
    const rule = "=".repeat(46);
    const thin = "-".repeat(46);
    const excerpt = EXCERPTS[book.cat] || EXCERPTS["文学"];
    const toc = CHAPTERS.map((c) => "  " + c).join("\n");

    return `\ufeff${rule}
                《${book.title}》
                作者：${book.author}
${rule}
  分　　类：${book.cat}
  字　　数：约 ${wordsText(book.words)}
  文件大小：约 ${fileSize(book.words)}
  豆瓣评分：${book.rating.toFixed(1)} / 10
  出版年份：${book.year}
  书　　源：${book.sources.join(" / ")}
  检索时间：${nowText()}
${thin}

【内容简介】

${book.blurb}

${thin}

【目　录】

${toc}

${thin}

【正文 · 试读节选】

${excerpt}

${thin}
由「墨库 MOKU LIBRARY」聚合导出。
本文件为演示版试读片段，完整版本请前往对应书源获取。
如有侵权，请联系删除。
`;
  }

  function downloadBook(book, trigger) {
    if (!book || !trigger) return;
    const original = trigger.innerHTML;
    trigger.disabled = true;
    trigger.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" style="animation:spin 0.9s linear infinite"><path d="M12 4a8 8 0 1 0 8 8"/></svg> 生成中…`;

    setTimeout(() => {
      const text = buildTxt(book);
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `《${book.title}》 ${book.author} · 墨库.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);

      trigger.disabled = false;
      trigger.innerHTML = original;
      toast(`《${book.title}》 TXT 已下载 · ${fileSize(book.words)}`);
    }, 560);
  }

  /* ---------- modal ---------- */
  function openBook(book) {
    state.current = book;
    $("#modalCover").innerHTML = coverHTML(book);
    $("#modalCat").textContent = book.cat + " · " + book.year;
    $("#modalTitle").textContent = book.title;
    $("#modalAuthor").textContent = book.author;
    $("#modalBlurb").textContent = book.blurb;
    $("#modalWords").textContent = "约 " + wordsText(book.words);
    $("#modalRating").textContent = book.rating.toFixed(1) + " / 10";
    $("#modalSize").textContent = "TXT " + fileSize(book.words);
    $("#modalYear").textContent = book.year;
    $("#modalSources").innerHTML = book.sources.map((s) => `<span class="src-chip">${esc(s)}</span>`).join("");

    const dl = $("#modalDownload");
    dl.disabled = false;
    dl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg> 下载 TXT`;

    els.bookModal.hidden = false;
    document.body.classList.add("no-scroll");
  }

  function openSources() {
    els.sourceGrid.innerHTML = SOURCES.map(
      (s) =>
        `<div class="source-item${OFFLINE_SOURCES.includes(s) ? " is-off" : ""}"><span>${esc(s)}</span><i></i></div>`
    ).join("");
    els.sourcesModal.hidden = false;
    document.body.classList.add("no-scroll");
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (!document.querySelector(".modal:not([hidden])")) {
      document.body.classList.remove("no-scroll");
    }
  }

  /* ---------- events ---------- */
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
      if (state.results.length) renderResults();
    });
  });

  els.resultList.addEventListener("click", (e) => {
    const dl = e.target.closest("[data-dl]");
    if (dl) {
      const book = BOOKS.find((b) => b.id === dl.dataset.dl);
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
      const book = BOOKS.find((b) => b.id === row.dataset.id);
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
  els.input.value = "";

  const initialQ = new URLSearchParams(location.search).get("q");
  if (initialQ) {
    els.input.value = initialQ;
    setTimeout(() => runSearch(initialQ), 300);
  }
})();
