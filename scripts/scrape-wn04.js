/**
 * 紳士漫畫 (wn04.cfd) 下载脚本
 *
 * 用法:
 *   node scripts/scrape-wn04.js <album-url> [选项]
 *
 * 示例:
 *   node scripts/scrape-wn04.js "https://www.wn04.cfd/photos-index-aid-359672.html"
 *   node scripts/scrape-wn04.js "https://www.wn04.cfd/photos-slide-aid-359672.html"
 *   node scripts/scrape-wn04.js 359672                       # 直接用 aid
 *
 * 环境变量:
 *   CONCURRENCY=5   并行下载数（默认 5）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ========== 参数解析 ==========
const args = process.argv.slice(2);
const INPUT = args.find(a => !a.startsWith('--')) || '';
const FLAG_OUT = getFlagValue('--output') || 'downloads';
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 5;

function getFlagValue(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}

// ========== 工具函数 ==========

function parseAid(input) {
  // 支持 URL 或纯数字 aid
  const m = input.match(/aid[_-]?(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(input)) return input;
  return null;
}

function parseTitle(html) {
  const m = html.match(/<title>([^<]+)/);
  return m ? m[1].replace(/ - 紳士漫畫.*$/, '').trim() : `album-${aid}`;
}

function extractJson(html) {
  const m = html.match(/mReader\.initData\s*\(\s*({.+?})\s*\)\s*;/s);
  if (!m) return null;
  try {
    // 清除尾随逗号（JSON5 风格，但只用 JSON.parse）
    const clean = m[1].replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(clean);
  } catch { return null; }
}

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
}

function padNum(n, total) {
  return String(n).padStart(String(total).length, '0');
}

function download(url, dest, referer) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: referer || 'https://www.wn04.cfd/',
      },
      timeout: 30000,
    };
    mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(new URL(res.headers.location, url).href, dest, referer).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.wn04.cfd/',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(new URL(res.headers.location, url).href).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

// ========== 主流程 ==========

(async () => {
  if (!INPUT) {
    console.log('用法: node scripts/scrape-wn04.js <album-url|aid> [选项]');
    console.log('');
    console.log('示例:');
    console.log('  node scripts/scrape-wn04.js "https://www.wn04.cfd/photos-index-aid-359672.html"');
    console.log('  node scripts/scrape-wn04.js 359672');
    console.log('');
    console.log('选项:');
    console.log('  --output DIR  输出目录（默认 ./downloads）');
    console.log('');
    console.log('环境变量:');
    console.log('  CONCURRENCY=5  并行下载数（默认 5）');
    process.exit(1);
  }

  const aid = parseAid(INPUT);
  if (!aid) {
    console.error('× 无法解析 aid，请提供专辑 URL 或数字 aid');
    process.exit(1);
  }

  // ========== 获取图片列表 ==========
  console.log(`获取专辑信息 (aid: ${aid})...`);
  const itemUrl = `https://www.wn04.cfd/photos-item-aid-${aid}.html`;

  let html;
  try {
    html = await httpGet(itemUrl);
  } catch (e) {
    console.error(`× 获取失败: ${e.message}`);
    process.exit(1);
  }

  const data = extractJson(html);
  if (!data || !data.page_url || data.page_url.length === 0) {
    console.error('× 未找到图片数据，页面可能返回了空内容');
    process.exit(1);
  }

  const imgUrls = data.page_url;
  console.log(`找到 ${imgUrls.length} 张图片\n`);

  // 获取标题（从 album 页面）
  let albumTitle = `aid-${aid}`;
  try {
    const albumHtml = await httpGet(`https://www.wn04.cfd/photos-index-aid-${aid}.html`);
    const titleMatch = albumHtml.match(/<title>([^<]+)/);
    if (titleMatch) {
      albumTitle = titleMatch[1].replace(/ - 紳士漫畫.*$/, '').trim() || albumTitle;
    }
  } catch { /* 用默认标题 */ }

  const outDir = path.join(FLAG_OUT, sanitize(albumTitle));
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`输出目录: ${outDir}\n`);

  // ========== 下载 ==========
  let downloaded = 0;
  let failed = 0;

  const tasks = imgUrls.map((url, i) => {
    const ext = url.match(/\.(webp|jpe?g|png|gif)/i)?.[1]?.replace(/jpeg/i, 'jpg') || 'jpg';
    const filename = `${padNum(i + 1, imgUrls.length)}.${ext}`;
    const dest = path.join(outDir, filename);
    return { url, dest, index: i + 1 };
  });

  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ url, dest, index }) => {
      try {
        await download(url, dest, 'https://www.wn04.cfd/');
        const stat = fs.statSync(dest);
        if (stat.size < 1000) {
          fs.unlinkSync(dest);
          throw new Error(`太小(${stat.size}b)`);
        }
        downloaded++;
        process.stdout.write(`\r  [${downloaded + failed}/${tasks.length}] 第 ${index} 页 ✓ (${(stat.size / 1024).toFixed(0)}KB)`);
      } catch (e) {
        try { fs.unlinkSync(dest); } catch { /* ok */ }
        failed++;
        process.stdout.write(`\r  [${downloaded + failed}/${tasks.length}] 第 ${index} 页 × ${e.message.slice(0, 30)}`);
      }
    }));
  }

  // ========== 汇总 ==========
  console.log(`\n\n======== 完成 ========`);
  console.log(`目录: ${outDir}`);
  console.log(`结果: ${downloaded}/${tasks.length} 张成功`);
  if (failed > 0) console.log(`失败: ${failed} 张`);
})();
