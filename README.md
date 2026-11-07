# 墨库 MOKU · 电子书检索站

一个聚合式电子书检索演示站：一次检索，聚合公开书源，直接导出 UTF-8 编码的 TXT 电子书。

## 站点地址

线上：<https://moku-library.pages.dev>

## 文件结构

```
index.html   页面结构
styles.css   样式
books.js     示例书目数据
app.js       检索、筛选、TXT 导出逻辑
```

## 本地预览

直接用浏览器打开 `index.html` 即可，无需构建。

## 部署

- 已通过 **Cloudflare Pages** 部署
- 仓库已与 Cloudflare Pages 关联，`git push` 到 `main` 分支即自动重新部署

## 说明

本站书目索引与 TXT 正文为演示数据，正式运营请接入合法授权的书源接口。
