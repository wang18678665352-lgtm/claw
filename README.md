# claw

一组基于 Playwright + Node.js 的爬虫脚本集合，用于下载漫画、视频、图片和文章。

## 环境要求

- Node.js 18+
- 安装依赖：`npm install && npx playwright install chromium`
- 可选：`@ffmpeg-installer/ffmpeg` 或系统 ffmpeg（B 站番剧音视频合并用）

## 脚本一览

| 脚本 | 用途 |
|---|---|
| `scripts/scrape-copymanga.js` | 拷贝漫画章节下载 |
| `scripts/verify-copymanga.js` | 拷贝漫画下载完整性校验 |
| `scripts/scrape-bilibili.js` | B 站单个视频信息 + 视频下载 |
| `scripts/scrape-bilibili-bangumi.js` | B 站番剧整季下载（需登录） |
| `scripts/bilibili-login.js` | B 站扫码登录，保存登录态 |
| `scripts/scrape-zhihu.js` | 知乎文章正文 + 图片导出 Markdown |
| `scripts/scrape-images.js` | Google/Bing 图片批量下载 |
| `scripts/scrape-wn04.js` | 紳士漫畫单专辑下载 |
| `scripts/scrape-wn04-bookshelf.js` | 紳士漫畫书架按分类批量下载（需登录） |

## 拷贝漫画（copymanga）

```bash
# 列出全部章节（带序号，不下载）
node scripts/scrape-copymanga.js grandblue --list

# 按序号范围下载（注意：序号是列表位置，不是"第几话"）
node scripts/scrape-copymanga.js grandblue --start 13 --end 78 --parallel 2

# 下载最新 N 话
node scripts/scrape-copymanga.js grandblue --latest 5

# 校验已下载章节的完整性（缺页的目录会被删除，重跑下载命令即可补齐）
node scripts/verify-copymanga.js grandblue --start 13 --end 115
```

选项：

- `--start N` / `--end N` — 章节序号范围（以 `--list` 输出为准）
- `--latest N` — 最新 N 话
- `--parallel N` — 并行浏览器实例数（默认 1；建议 ≤2，过高容易触发限流）
- `--output DIR` — 输出目录（默认 `./downloads`）
- 环境变量 `CONCURRENCY=N` — 每浏览器内图片并发数（默认 3）

特性：滚动提取以页面 `.comicCount`（真实总页数）为准，自动过滤广告图；已下载的章节自动跳过；下载超时自动重试。

## B 站

```bash
# 首次使用先扫码登录（登录态保存到 .auth/bilibili.json）
node scripts/bilibili-login.js

# 单个视频（信息 + 封面 + 视频流，DASH 高画质需 ffmpeg 合并）
node scripts/scrape-bilibili.js https://www.bilibili.com/video/BVxxxx

# 番剧整季（需先登录；第二个参数限制下载集数）
node scripts/scrape-bilibili-bangumi.js https://www.bilibili.com/bangumi/play/ss44818 3
```

## 其他

```bash
# 知乎文章
node scripts/scrape-zhihu.js https://zhuanlan.zhihu.com/p/xxxx

# 图片搜索下载（默认 20 张，ENGINE=bing 可换 Bing）
node scripts/scrape-images.js "cat"

# 紳士漫畫单专辑
node scripts/scrape-wn04.js "https://www.wn04.cfd/photos-index-aid-359672.html"

# 紳士漫畫书架（首次运行会打开浏览器要求登录）
node scripts/scrape-wn04-bookshelf.js --parallel 2
```

## 注意事项

- 多数脚本会弹出真实浏览器窗口（`headless: false`）以绕过反爬，运行时请勿操作这些窗口。
- `.auth/`（登录态）和 `.browser-profile/`（浏览器配置）已加入 `.gitignore`，请勿提交。
- 下载产物默认输出到 `downloads/` 或项目根目录下以站点名开头的目录。
