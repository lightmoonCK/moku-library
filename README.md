# 墨库 MOKU · 公开书源电子书检索

一次检索，并行聚合多个公开书源，命中公开全文的书可直接下载 UTF-8 TXT。

## 站点地址

线上：<https://moku-library.pages.dev>

## 书源

| 书源 | 用途 |
| --- | --- |
| Project Gutenberg（Gutendex） | 公共领域全文，提供 TXT 直链 |
| Open Library | 全球书目元数据、封面与馆藏 |
| Internet Archive | 扫描本 OCR 全文（`*_djvu.txt`） |
| Google Books | 书目、简介与读者评分 |

检索由 `functions/api/search.js` 在 Cloudflare 边缘并行发起，按书名 + 作者去重合并，单个书源超时或限流不影响整体结果。全文下载走 `functions/api/txt.js` 白名单代理，只允许上述书源的 HTTPS 明文地址。

## 文件结构

```
index.html              页面结构
styles.css              样式
app.js                  检索、筛选、排序、弹窗、TXT 导出
books.js                内置离线书架（书源不可用时的降级数据）
functions/api/search.js 书源聚合接口 GET /api/search?q=
functions/api/txt.js    全文代理接口 GET /api/txt?u=
```

## 本地预览

`/api/*` 是 Cloudflare Pages Functions，纯静态打开会退化为离线书架。要完整体验需：

```bash
npx wrangler pages dev .
```

## 部署

- 已通过 **Cloudflare Pages** 部署，仓库与项目关联，`git push` 到 `main` 自动重新部署
- Pages 会自动识别根目录下的 `functions/` 目录并部署 Functions

## 说明

墨库本身不存储任何书籍文件，书目与正文均来自公开书源，版权归原作者与书源所有。`books.js` 中的内置书目仅用于断网降级演示。
