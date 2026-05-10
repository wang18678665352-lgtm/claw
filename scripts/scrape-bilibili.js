const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = process.argv[2];
if (!URL || !URL.includes('bilibili.com/video/')) {
  console.error('用法: node scripts/scrape-bilibili.js <B站视频URL>');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  console.log('正在加载页面...');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 从 window.__INITIAL_STATE__ 提取视频信息
  const videoInfo = await page.evaluate(() => {
    const state = window.__INITIAL_STATE__;
    if (!state?.videoData) return null;

    const v = state.videoData;
    return {
      bvid: v.bvid,
      aid: v.aid,
      cid: v.cid,
      title: v.title,
      desc: v.desc || v.description || '',
      owner: { name: v.owner?.name, mid: v.owner?.mid, face: v.owner?.face },
      stat: {
        view: v.stat?.view,
        danmaku: v.stat?.danmaku,
        reply: v.stat?.reply,
        favorite: v.stat?.favorite,
        coin: v.stat?.coin,
        share: v.stat?.share,
        like: v.stat?.like,
      },
      pic: v.pic,
      pubdate: v.pubdate,
      duration: v.duration,
      pages: (v.pages || []).map(p => ({ cid: p.cid, title: p.part, duration: p.duration })),
      tags: (v.tags || []).map(t => t.tag_name || t),
    };
  });

  if (!videoInfo) {
    console.log('未能提取视频信息，页面可能需要登录或已改版。');
    await browser.close();
    process.exit(1);
  }

  const v = videoInfo;
  console.log(`\n标题: ${v.title}`);
  console.log(`UP主: ${v.owner.name} (mid: ${v.owner.mid})`);
  console.log(`播放: ${fmt(v.stat.view)} | 弹幕: ${fmt(v.stat.danmaku)} | 点赞: ${fmt(v.stat.like)} | 投币: ${fmt(v.stat.coin)}`);
  console.log(`分P: ${v.pages.length} 个`);
  if (v.tags.length) console.log(`标签: ${v.tags.join(', ')}`);

  // 创建输出目录
  const dirName = `bilibili-${sanitize(v.title.slice(0, 30))}`;
  const outDir = path.join(__dirname, '..', dirName);
  fs.mkdirSync(outDir, { recursive: true });

  // 下载封面
  console.log('\n下载封面...');
  const coverExt = v.pic.match(/\.(jpe?g|png|webp)/i)?.[1] || 'jpg';
  const coverPath = path.join(outDir, `cover.${coverExt}`);
  await download(v.pic, coverPath, URL);
  console.log(`  封面已保存: cover.${coverExt}`);

  // 调 B 站 API 获取视频播放直链
  console.log('\n获取视频直链...');
  const playUrls = [];
  for (const page of v.pages) {
    const apiUrl = `https://api.bilibili.com/x/player/playurl?bvid=${v.bvid}&cid=${page.cid}&qn=80&fnval=1&fourk=1`;
    try {
      const data = await apiGet(apiUrl, URL);
      const durl = data?.data?.durl;
      const dash = data?.data?.dash;
      const quality = data?.data?.quality;

      const entry = {
        page: page.title || 'P1',
        cid: page.cid,
        quality,
        accept_quality: data?.data?.accept_description || [],
      };

      if (durl && durl.length > 0) {
        // 传统 mp4/flv 地址（低画质时有）
        entry.mode = 'single';
        entry.urls = durl.map(d => ({ url: d.url, size: d.size }));
        // 尝试下载第一个分段
        console.log(`  [${entry.page}] qn=${quality} 直链模式，共${durl.length}段`);
        const videoPath = path.join(outDir, `${sanitize(entry.page)}.mp4`);
        await download(durl[0].url, videoPath, URL);
        console.log(`  已下载: ${sanitize(entry.page)}.mp4`);
      } else if (dash) {
        // DASH 模式（高画质）—— 音画分离，需要 ffmpeg 合并
        entry.mode = 'dash';
        entry.video = dash.video?.map(d => ({ id: d.id, url: d.baseUrl || d.base_url, width: d.width, height: d.height, codecs: d.codecs, bandwidth: d.bandwidth }));
        entry.audio = dash.audio?.map(d => ({ id: d.id, url: d.baseUrl || d.base_url, codecs: d.codecs, bandwidth: d.bandwidth }));
        console.log(`  [${entry.page}] DASH 模式 (qn=${quality}) — 音画分离，需 ffmpeg 合并`);
        console.log(`    视频流: ${entry.video?.length || 0} 个`);
        console.log(`    音频流: ${entry.audio?.length || 0} 个`);

        // 下载最高画质视频流和音频流
        if (entry.video?.length > 0 && entry.audio?.length > 0) {
          const bestVideo = entry.video[0];
          const bestAudio = entry.audio[0];

          const videoFile = path.join(outDir, `${sanitize(entry.page)}_video.mp4`);
          const audioFile = path.join(outDir, `${sanitize(entry.page)}_audio.mp4`);
          const mergedFile = path.join(outDir, `${sanitize(entry.page)}.mp4`);

          console.log(`    下载视频流 (${bestVideo.width}x${bestVideo.height})...`);
          await download(bestVideo.url, videoFile, URL);
          console.log(`    下载音频流...`);
          await download(bestAudio.url, audioFile, URL);

          entry.videoFile = videoFile;
          entry.audioFile = audioFile;
          entry.mergedFile = mergedFile;
          entry.needMerge = true;
        }
      }

      playUrls.push(entry);
    } catch (e) {
      console.log(`  [${page.title}] 获取失败: ${e.message}`);
      playUrls.push({ page: page.title || 'P1', cid: page.cid, error: e.message });
    }
  }

  // 保存 Markdown
  const md = [
    `# ${v.title}`,
    '',
    `> UP主: [${v.owner.name}](https://space.bilibili.com/${v.owner.mid})`,
    `> 来源: ${URL}`,
    `> 发布时间: ${new Date(v.pubdate * 1000).toLocaleDateString('zh-CN')}`,
    `> 时长: ${Math.floor(v.duration / 60)}分${v.duration % 60}秒`,
    '',
    `| 指标 | 数值 |`,
    `|------|------|`,
    `| 播放 | ${fmt(v.stat.view)} |`,
    `| 弹幕 | ${fmt(v.stat.danmaku)} |`,
    `| 点赞 | ${fmt(v.stat.like)} |`,
    `| 投币 | ${fmt(v.stat.coin)} |`,
    `| 收藏 | ${fmt(v.stat.favorite)} |`,
    `| 转发 | ${fmt(v.stat.share)} |`,
    `| 评论 | ${fmt(v.stat.reply)} |`,
    '',
    `![封面](cover.${coverExt})`,
    '',
    `## 简介`,
    '',
    v.desc || '(无)',
    '',
    `## 分P信息`,
    '',
    ...v.pages.map(p => `- **${p.title || '默认'}** (cid: ${p.cid}, ${Math.floor(p.duration / 60)}分${p.duration % 60}秒)`),
    '',
    `## 下载状态`,
    '',
  ];

  // 追加下载状态
  for (const entry of playUrls) {
    if (entry.error) {
      md.push(`- **${entry.page}**: 获取失败 — ${entry.error}`);
    } else if (entry.needMerge) {
      md.push(`- **${entry.page}**: 已下载视频流 + 音频流（DASH 分片，需用 ffmpeg 合并）`);
      md.push(`  - 视频: \`${path.basename(entry.videoFile)}\``);
      md.push(`  - 音频: \`${path.basename(entry.audioFile)}\``);
      md.push(`  - 合并命令: \`ffmpeg -i "${path.basename(entry.videoFile)}" -i "${path.basename(entry.audioFile)}" -c copy "${path.basename(entry.mergedFile)}"\``);
    } else {
      md.push(`- **${entry.page}**: 已下载 ✓`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'article.md'), md.join('\n'), 'utf-8');

  console.log(`\n已保存到: ${dirName}/`);
  console.log(`  - article.md`);
  console.log(`  - cover.${coverExt}`);

  await browser.close();
  console.log('\n完成。');
})();

function apiGet(url, referer) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            Referer: referer,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          },
          timeout: 15000,
        },
        (res) => {
          let body = '';
          res.on('data', chunk => (body += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('API 返回非 JSON'));
            }
          });
        }
      )
      .on('error', reject);
  });
}

function download(src, dest, referer) {
  return new Promise((resolve, reject) => {
    const mod = src.startsWith('https') ? https : require('http');
    mod
      .get(
        src,
        {
          headers: {
            Referer: referer,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          },
          timeout: 60000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            download(res.headers.location, dest, referer).then(resolve).catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const total = parseInt(res.headers['content-length'], 10);
          let downloaded = 0;
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          res.on('data', chunk => {
            downloaded += chunk.length;
            if (total) {
              const pct = ((downloaded / total) * 100).toFixed(1);
              process.stdout.write(`\r  进度: ${pct}% (${fmtSize(downloaded)}/${fmtSize(total)})`);
            }
          });
          file.on('finish', () => {
            process.stdout.write('\n');
            file.close();
            resolve();
          });
          file.on('error', reject);
        }
      )
      .on('error', reject);
  });
}

function fmt(n) {
  if (!n) return '0';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toLocaleString();
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim();
}
