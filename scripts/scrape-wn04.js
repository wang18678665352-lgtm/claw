/**
 * 紳士漫畫 (wn04.cfd) 下载脚本
 *
 * 用法:
 *   node scripts/scrape-wn04.js <album-url|aid> [选项]   # 下载单个专辑
 *   node scripts/scrape-wn04.js --rankings [选项]        # 下载排行榜
 *
 * 单专辑示例:
 *   node scripts/scrape-wn04.js "https://www.wn04.cfd/photos-index-aid-359672.html"
 *   node scripts/scrape-wn04.js 359672
 *
 * 排行榜模式（日/周/月/年榜 × 各题材，取前 N 个，递归保存）:
 *   node scripts/scrape-wn04.js --rankings                        # 全部题材 × 日/周/月榜 × 前10
 *   node scripts/scrape-wn04.js --rankings --top 20               # 每榜前 20
 *   node scripts/scrape-wn04.js --rankings --types week,month     # 只爬周榜和月榜
 *   node scripts/scrape-wn04.js --rankings --cates 5,2,37         # 只爬指定题材 id
 *
 * 选项:
 *   --output DIR    输出目录（单专辑默认 ./downloads，排行榜默认 ./downloads/wn04-rankings）
 *   --top N         排行榜每个榜取前 N 个（默认 10）
 *   --types LIST    榜单类型: day,week,month,year（默认 day,week,month）
 *   --cates LIST    题材分类 id 列表或 all（默认 all，自动从首页发现）
 *   --parallel N    排行榜模式同时下载的专辑数（默认 2）
 *
 * 输出结构（已完整下载的专辑带 .done 标记，重复运行自动跳过）:
 *   <output>/日榜/同人誌/漢化/01-标题/001.jpg ...
 *
 * 环境变量:
 *   CONCURRENCY=5   专辑内图片并行下载数（默认 5）
 *   WN_BASE=...     站点域名（默认 https://www.wn04.cfd，会自动跟随跳转）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ========== 参数解析 ==========
const args = process.argv.slice(2);
const INPUT = args.find(a => !a.startsWith('--')) || '';
const MODE_RANKINGS = args.includes('--rankings');
const FLAG_OUT = getFlagValue('--output');
const FLAG_TOP = parseInt(getFlagValue('--top') || '10', 10);
const FLAG_TYPES = (getFlagValue('--types') || 'day,week,month').split(',').map(s => s.trim()).filter(Boolean);
const FLAG_CATES = getFlagValue('--cates') || 'all';
const FLAG_PARALLEL = parseInt(getFlagValue('--parallel') || '2', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 5;
const BASE = (process.env.WN_BASE || 'https://www.wn04.cfd').replace(/\/+$/, '');

const TYPE_LABELS = { day: '日榜', week: '周榜', month: '月榜', year: '年榜' };

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function download(url, dest, referer, retries = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: referer || `${BASE}/`,
      },
      timeout: 30000,
    };
    const req = mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).href, dest, referer, retries).then(resolve).catch(reject);
      }
      if (res.statusCode === 429 && retries > 0) {
        res.resume();
        const delay = Math.min(12000, (4 - retries) * 4000 + Math.random() * 2000);
        return setTimeout(() => download(url, dest, referer, retries - 1).then(resolve).catch(reject), delay);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (e) => { try { file.close(); fs.unlinkSync(dest); } catch {} reject(e); });
      res.on('error', (e) => { try { file.close(); fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpGet(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `${BASE}/`,
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, url).href, retries).then(resolve).catch(reject);
      }
      if (res.statusCode === 429 && retries > 0) {
        res.resume();
        const delay = Math.min(12000, (4 - retries) * 4000 + Math.random() * 2000);
        return setTimeout(() => httpGet(url, retries - 1).then(resolve).catch(reject), delay);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ========== 专辑下载（递归保存，带 .done 断点跳过） ==========

async function getAlbumImages(aid) {
  const html = await httpGet(`${BASE}/photos-item-aid-${aid}.html`);
  const data = extractJson(html);
  return data && data.page_url && data.page_url.length > 0 ? data.page_url : null;
}

async function getAlbumTitle(aid) {
  try {
    const html = await httpGet(`${BASE}/photos-index-aid-${aid}.html`);
    const m = html.match(/<title>([^<]+)/);
    return m ? m[1].replace(/ - 紳士漫畫.*$/, '').trim() : null;
  } catch {
    return null;
  }
}

/**
 * 下载单个专辑到 destDir。
 * 返回 { status: 'done'|'skipped'|'no-images', downloaded, failed, total }
 */
async function downloadAlbum(aid, knownTitle, destDir) {
  const doneMark = path.join(destDir, '.done');
  if (fs.existsSync(doneMark)) {
    const count = fs.readdirSync(destDir).filter(f => f !== '.done').length;
    return { status: 'skipped', downloaded: count, failed: 0, total: count };
  }

  const imgUrls = await getAlbumImages(aid);
  if (!imgUrls) return { status: 'no-images' };

  let albumTitle = knownTitle;
  if (!albumTitle) {
    albumTitle = await getAlbumTitle(aid) || `aid-${aid}`;
  }

  fs.mkdirSync(destDir, { recursive: true });

  let downloaded = 0;
  let failed = 0;
  const albumReferer = `${BASE}/photos-index-aid-${aid}.html`;

  const tasks = imgUrls.map((url, i) => {
    const ext = url.match(/\.(webp|jpe?g|png|gif)/i)?.[1]?.replace(/jpeg/i, 'jpg') || 'jpg';
    const filename = `${padNum(i + 1, imgUrls.length)}.${ext}`;
    return { url, dest: path.join(destDir, filename), index: i + 1 };
  });

  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ url, dest, index }) => {
      try {
        await download(url, dest, albumReferer);
        const stat = fs.statSync(dest);
        if (stat.size < 1000) {
          fs.unlinkSync(dest);
          throw new Error(`太小(${stat.size}b)`);
        }
        downloaded++;
        process.stdout.write(`\r    [${downloaded + failed}/${tasks.length}] 第 ${index} 页 ✓ (${(stat.size / 1024).toFixed(0)}KB)  `);
      } catch (e) {
        try { fs.unlinkSync(dest); } catch { /* ok */ }
        failed++;
        process.stdout.write(`\r    [${downloaded + failed}/${tasks.length}] 第 ${index} 页 × ${e.message.slice(0, 30)}  `);
      }
    }));
    if (i + CONCURRENCY < tasks.length) {
      await sleep(800 + Math.random() * 600);
    }
  }
  if (tasks.length > 0) process.stdout.write('\n');

  if (downloaded === 0 && failed > 0) {
    try { fs.rmdirSync(destDir); } catch { /* ok */ }
  } else if (failed === 0) {
    fs.writeFileSync(doneMark, `${downloaded}/${tasks.length}\n`, 'utf-8');
  }

  return { status: 'done', downloaded, failed, total: imgUrls.length };
}

// ========== 排行榜解析 ==========

/** 从首页发现所有题材分类 id（保持页面顺序） */
async function fetchCategoryIds() {
  const html = await httpGet(`${BASE}/`);
  const ids = [];
  const seen = new Set();
  for (const m of html.matchAll(/\/albums-index-cate-(\d+)\.html/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

/** 从排行榜页面包屑解析题材路径，如 ['同人誌', '漢化'] */
function parseCategoryPath(html, cateId) {
  const m = html.match(/class="png bread">([\s\S]*?)<\/div>/);
  if (!m) return [`cate-${cateId}`];
  const text = m[1].replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const parts = text.split('>').map(s => s.trim()).filter(Boolean);
  const idx = parts.findIndex(p => p.includes('排行榜'));
  const catePath = idx === -1 ? [] : parts.slice(idx + 1);
  return catePath.length > 0 ? catePath : [`cate-${cateId}`];
}

/** 解析排行榜一页的专辑条目（按页面顺序去重） */
function parseRankingEntries(html) {
  const entries = [];
  const seen = new Set();
  for (const m of html.matchAll(/\/photos-index-aid-(\d+)\.html" title="([^"]*)"/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    entries.push({ aid: m[1], title: m[2].trim() });
  }
  return entries;
}

/** 获取某个题材某个榜单的前 N 个专辑 */
async function fetchRankingTop(type, cateId, top) {
  const entries = [];
  const seen = new Set();
  let catePath = null;
  let page = 1;

  while (entries.length < top) {
    const url = page === 1
      ? `${BASE}/albums-favorite_ranking-type-${type}-cate-${cateId}.html`
      : `${BASE}/albums-favorite_ranking-page-${page}-type-${type}-cate-${cateId}.html`;

    let html;
    try {
      html = await httpGet(url);
    } catch (e) {
      console.log(`    × 第 ${page} 页获取失败: ${e.message}`);
      break;
    }

    if (!catePath) catePath = parseCategoryPath(html, cateId);

    const pageEntries = parseRankingEntries(html);
    if (pageEntries.length === 0) break;

    for (const e of pageEntries) {
      if (seen.has(e.aid)) continue;
      seen.add(e.aid);
      entries.push(e);
      if (entries.length >= top) break;
    }

    page++;
    if (entries.length < top) await sleep(600 + Math.random() * 400);
  }

  return { catePath: catePath || [`cate-${cateId}`], entries };
}

// ========== 排行榜模式 ==========

async function runRankings() {
  const outBase = FLAG_OUT || path.join('downloads', 'wn04-rankings');

  for (const t of FLAG_TYPES) {
    if (!TYPE_LABELS[t]) {
      console.error(`× 未知榜单类型: ${t}（可选: ${Object.keys(TYPE_LABELS).join(',')}）`);
      process.exit(1);
    }
  }

  let cateIds;
  if (FLAG_CATES === 'all') {
    console.log('从首页发现题材分类...');
    cateIds = await fetchCategoryIds();
    if (cateIds.length === 0) {
      console.error('× 未发现任何题材分类');
      process.exit(1);
    }
  } else {
    cateIds = FLAG_CATES.split(',').map(s => s.trim()).filter(Boolean);
  }

  console.log(`榜单: ${FLAG_TYPES.map(t => TYPE_LABELS[t]).join(' / ')}`);
  console.log(`题材: ${cateIds.length} 个 (${cateIds.join(', ')})`);
  console.log(`每榜取前 ${FLAG_TOP} 个，输出到 ${outBase}\n`);

  let totalAlbums = 0;
  let totalImages = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const type of FLAG_TYPES) {
    for (const cateId of cateIds) {
      const { catePath, entries } = await fetchRankingTop(type, cateId, FLAG_TOP);
      const cateName = catePath.join('/');
      console.log(`\n===== ${TYPE_LABELS[type]} / ${cateName} (前 ${entries.length} 个) =====`);

      if (entries.length === 0) {
        console.log('  (空)');
        continue;
      }

      const typeDir = path.join(outBase, sanitize(TYPE_LABELS[type]), ...catePath.map(sanitize));

      for (let i = 0; i < entries.length; i += FLAG_PARALLEL) {
        const batch = entries.slice(i, i + FLAG_PARALLEL);
        const results = await Promise.allSettled(batch.map(async (entry, j) => {
          const rank = i + j + 1;
          const dirName = `${padNum(rank, entries.length)}-${sanitize(entry.title || `aid-${entry.aid}`)}`;
          const destDir = path.join(typeDir, dirName);
          const shortTitle = (entry.title || entry.aid).slice(0, 40);
          const result = await downloadAlbum(entry.aid, entry.title, destDir);
          return { rank, shortTitle, result };
        }));

        for (const r of results) {
          if (r.status === 'fulfilled') {
            const { rank, shortTitle, result } = r.value;
            if (result.status === 'skipped') {
              console.log(`  [↻] #${rank} ${shortTitle}`);
              totalSkipped++;
            } else if (result.status === 'done') {
              console.log(`  [✓] #${rank} ${shortTitle} (${result.downloaded}/${result.total})`);
              totalAlbums++;
              totalImages += result.downloaded;
              if (result.failed > 0) totalFailed++;
            } else {
              console.log(`  [×] #${rank} ${shortTitle} 无图片`);
              totalFailed++;
            }
          } else {
            console.log(`  [!] ${(r.reason?.message || '未知错误').slice(0, 80)}`);
            totalFailed++;
          }
        }
        await sleep(500 + Math.random() * 500);
      }
    }
  }

  console.log(`\n\n======== 全部完成 ========`);
  console.log(`输出目录: ${outBase}`);
  console.log(`专辑: ${totalAlbums} 个新下载 + ${totalSkipped} 个已存在`);
  console.log(`图片: ${totalImages} 张`);
  if (totalFailed > 0) console.log(`失败/不完整: ${totalFailed} 个`);
}

// ========== 单专辑模式 ==========

async function runSingle() {
  if (!INPUT) {
    console.log('用法: node scripts/scrape-wn04.js <album-url|aid> [选项]');
    console.log('      node scripts/scrape-wn04.js --rankings [选项]');
    console.log('');
    console.log('示例:');
    console.log('  node scripts/scrape-wn04.js "https://www.wn04.cfd/photos-index-aid-359672.html"');
    console.log('  node scripts/scrape-wn04.js 359672');
    console.log('  node scripts/scrape-wn04.js --rankings --top 10');
    console.log('');
    console.log('选项:');
    console.log('  --output DIR    输出目录（单专辑默认 ./downloads，排行榜默认 ./downloads/wn04-rankings）');
    console.log('  --top N         排行榜每榜取前 N 个（默认 10）');
    console.log('  --types LIST    榜单类型: day,week,month,year（默认 day,week,month）');
    console.log('  --cates LIST    题材分类 id 列表或 all（默认 all）');
    console.log('  --parallel N    排行榜模式同时下载的专辑数（默认 2）');
    console.log('');
    console.log('环境变量:');
    console.log('  CONCURRENCY=5  专辑内图片并行下载数（默认 5）');
    console.log('  WN_BASE=...    站点域名（默认 https://www.wn04.cfd）');
    process.exit(1);
  }

  const aid = parseAid(INPUT);
  if (!aid) {
    console.error('× 无法解析 aid，请提供专辑 URL 或数字 aid');
    process.exit(1);
  }

  console.log(`获取专辑信息 (aid: ${aid})...`);
  const albumTitle = await getAlbumTitle(aid) || `aid-${aid}`;
  const outDir = path.join(FLAG_OUT || 'downloads', sanitize(albumTitle));
  console.log(`输出目录: ${outDir}\n`);

  const result = await downloadAlbum(aid, albumTitle, outDir);

  console.log(`\n======== 完成 ========`);
  console.log(`目录: ${outDir}`);
  if (result.status === 'skipped') {
    console.log(`已完整下载过，跳过 (${result.downloaded} 张)`);
  } else if (result.status === 'no-images') {
    console.log('× 未找到图片数据，页面可能返回了空内容');
    process.exit(1);
  } else {
    console.log(`结果: ${result.downloaded}/${result.total} 张成功`);
    if (result.failed > 0) console.log(`失败: ${result.failed} 张`);
  }
}

// ========== 入口 ==========

process.on('unhandledRejection', (err) => {
  console.error(`\n[未捕获异常] ${err.message}`);
  process.exit(1);
});

(async () => {
  try {
    if (MODE_RANKINGS) {
      await runRankings();
    } else {
      await runSingle();
    }
  } catch (e) {
    console.error(`\n× 脚本异常: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
})();
