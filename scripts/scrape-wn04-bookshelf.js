/**
 * 紳士漫畫 (wn04.cfd) 书架下载脚本
 *
 * 登录你的书架，按分类创建文件夹下载所有内容。
 * 需要先在浏览器中登录（会自动打开浏览器）。
 *
 * 用法:
 *   node scripts/scrape-wn04-bookshelf.js [选项]
 *
 * 选项:
 *   --output DIR  输出目录（默认 ./downloads/wn04-bookshelf）
 *   --parallel N  并行下载数（默认 2，控制同时下载几个专辑）
 *   --all         下载全部（跳过交互确认）
 *
 * 环境变量:
 *   CONCURRENCY=5  每专辑内图片并行下载数（默认 2）
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// 强制 stdout 无缓冲（背景任务能实时捕获输出）
if (process.stdout._handle && typeof process.stdout._handle.setBlocking === 'function') {
  process.stdout._handle.setBlocking(true);
}

// ========== 参数解析 ==========
const args = process.argv.slice(2);
const FLAG_OUT = getFlagValue('--output') || path.join('downloads', 'wn04-bookshelf');
const FLAG_PARALLEL = parseInt(getFlagValue('--parallel') || '2', 10);
const FLAG_ALL = args.includes('--all');
const IMG_CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 2;

function getFlagValue(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}

// ========== 工具函数 ==========

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
}

function padNum(n, total) {
  return String(n).padStart(String(total).length, '0');
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.wn04.cfd/',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, url).href).then(resolve).catch(reject);
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

/** 通过 HTTP 下载图片（带重试和指数退避） */
function download(url, dest, referer, retries = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': referer || 'https://www.wn04.cfd/',
      },
      timeout: 20000,
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

/** 通过浏览器下载图片（使用 page.fetch，45s 超时，自动携带 cookies/headers） */
async function downloadViaBrowser(url, dest, page, referer) {
  const base64 = await page.evaluate(async ({ url, referer }) => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 45000);
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Referer': referer },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } finally {
      clearTimeout(tid);
    }
  }, { url, referer });

  const idx = base64.indexOf(';base64,');
  const data = base64.slice(idx + 8);
  fs.writeFileSync(dest, Buffer.from(data, 'base64'));
}

// ========== 从书架页面解析专辑 ==========

async function parseBookshelfPage(page) {
  return await page.evaluate(() => {
    const items = [];
    const catgs = document.querySelectorAll('p.l_catg');
    const titles = document.querySelectorAll('p.l_title');

    const count = Math.min(catgs.length, titles.length);
    for (let i = 0; i < count; i++) {
      const catLink = catgs[i].querySelector('a[href*="users-users_fav-c-"]');
      const titleLink = titles[i].querySelector('a[href*="photos-index-aid-"]');
      if (!catLink || !titleLink) continue;

      const category = catLink.textContent.trim() || '未分类';
      const href = titleLink.getAttribute('href') || '';
      const aidMatch = href.match(/aid[_-]?(\d+)/i);
      if (!aidMatch) continue;
      const aid = aidMatch[1];
      const title = (titleLink.textContent || '').trim();
      if (!title) continue;

      items.push({ aid, title, url: href, category });
    }

    return items;
  });
}

// ========== 从 API 获取图片列表 ==========

async function getAlbumImages(aid) {
  const url = `https://www.wn04.cfd/photos-item-aid-${aid}.html`;
  const html = await httpGet(url);
  const m = html.match(/mReader\.initData\s*\(\s*({.+?})\s*\)\s*;/s);
  if (!m) return null;
  const clean = m[1].replace(/,(\s*[}\]])/g, '$1');
  try {
    const data = JSON.parse(clean);
    return data.page_url || null;
  } catch {
    return null;
  }
}

// ========== 获取专辑标题 ==========

async function getAlbumTitle(aid) {
  try {
    const html = await httpGet(`https://www.wn04.cfd/photos-index-aid-${aid}.html`);
    const m = html.match(/<title>([^<]+)/);
    return m ? m[1].replace(/ - 紳士漫畫.*$/, '').trim() : null;
  } catch {
    return null;
  }
}

// ========== 下载单个专辑 ==========

async function downloadAlbum(aid, title, destDir, page) {
  const existing = fs.existsSync(destDir) ? fs.readdirSync(destDir) : [];
  if (existing.length > 0) {
    return { status: 'skipped', count: existing.length };
  }

  const imgUrls = await getAlbumImages(aid);
  if (!imgUrls || imgUrls.length === 0) {
    return { status: 'no-images' };
  }

  fs.mkdirSync(destDir, { recursive: true });

  let downloaded = 0;
  let failed = 0;
  const albumReferer = `https://www.wn04.cfd/photos-index-aid-${aid}.html`;

  const tasks = imgUrls.map((url, i) => {
    const ext = url.match(/\.(webp|jpe?g|png|gif)/i)?.[1]?.replace(/jpeg/i, 'jpg') || 'jpg';
    const filename = `${padNum(i + 1, imgUrls.length)}.${ext}`;
    const dest = path.join(destDir, filename);
    return { url, dest, index: i + 1 };
  });

  for (let i = 0; i < tasks.length; i += IMG_CONCURRENCY) {
    const batch = tasks.slice(i, i + IMG_CONCURRENCY);
    await Promise.all(batch.map(async ({ url, dest }) => {
      // 每张图片有 90s 总超时（HTTP 重试 + 浏览器 fallback）
      const result = await Promise.race([
        (async () => {
          try {
            await download(url, dest, albumReferer);
            const stat = fs.statSync(dest);
            if (stat.size < 1000) {
              fs.unlinkSync(dest);
              throw new Error(`太小(${stat.size}b)`);
            }
            return 'http';
          } catch (e) {
            try { fs.unlinkSync(dest); } catch { /* ok */ }
            // HTTP 失败 → 通过浏览器下载
            await downloadViaBrowser(url, dest, page, albumReferer);
            const stat = fs.statSync(dest);
            if (stat.size < 1000) {
              fs.unlinkSync(dest);
              throw new Error(`太小(${stat.size}b)`);
            }
            return 'browser';
          }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 90000)),
      ]);
      downloaded++;
    }));
    // 每批之间加延迟
    if (i + IMG_CONCURRENCY < tasks.length) {
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    }
  }

  if (downloaded === 0 && failed > 0) {
    try { fs.rmdirSync(destDir); } catch { /* ok */ }
  }

  return { status: 'done', downloaded, failed, total: imgUrls.length };
}

// ========== 主流程 ==========

process.on('unhandledRejection', (err) => {
  console.error(`\n[未捕获异常] ${err.message}`);
  process.exit(1);
});

(async () => {
  try {
  console.log('===== 紳士漫畫 书架下载器 =====\n');

  const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');
  let context;
  let page;

  console.log('检查登录状态...');

  // 启动浏览器（headless: true 避免窗口干扰）
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
  });
  page = context.pages()[0] || await context.newPage();

  await page.goto('https://www.wn04.cfd/users-index.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  const needsLogin = await page.evaluate(() => document.body.innerText.includes('需要登錄'));
  if (needsLogin) {
    await context.close();
    console.log('未登录，请在打开的浏览器中登录...');
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 800 },
    });
    page = context.pages()[0] || await context.newPage();
    await page.goto('https://www.wn04.cfd/users-login.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('等待登录（最长 5 分钟）...');
    let loggedIn = false;
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(1000);
      const text = await page.evaluate(() => document.body.innerText);
      if (!text.includes('需要登錄') && !text.includes('登錄')) {
        loggedIn = true;
        console.log('登录成功！');
        break;
      }
      if (i % 30 === 0 && i > 0) console.log(`  等待中... (${i / 30} 分钟)`);
    }
    if (!loggedIn) {
      console.log('× 登录超时');
      await context.close();
      process.exit(1);
    }
  } else {
    console.log('已登录\n');
  }

  // ========== 扫描书架 ==========
  console.log('扫描书架...\n');
  const allItems = [];
  const BOOKSHELF_URL = 'https://www.wn04.cfd/users-users_fav.html';

  await page.goto(BOOKSHELF_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1500);

  const totalPages = await page.evaluate(() => {
    const pageLinks = document.querySelectorAll('a[href*="users-users_fav-page-"]');
    let max = 1;
    pageLinks.forEach(a => {
      const m = a.href.match(/page[_-](\d+)/i);
      if (m) max = Math.max(max, parseInt(m[1]));
    });
    return max;
  });
  console.log(`书架共 ${totalPages} 页\n`);

  for (let p = 1; p <= totalPages; p++) {
    const pageUrl = p === 1
      ? BOOKSHELF_URL
      : `https://www.wn04.cfd/users-users_fav-page-${p}-c-0.html`;

    console.log(`  扫描第 ${p}/${totalPages} 页...`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);

    const items = await parseBookshelfPage(page);
    console.log(`    发现 ${items.length} 个专辑`);
    allItems.push(...items);
  }

  console.log(`\n书架共 ${allItems.length} 个专辑\n`);

  // ========== 按分类整理 ==========
  const categoryMap = new Map();
  const seenAids = new Set();

  for (const item of allItems) {
    const cat = item.category;
    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, []);
    }
    categoryMap.get(cat).push({ aid: item.aid, title: item.title });
    seenAids.add(item.aid);
  }

  console.log(`分类 (${categoryMap.size} 个):`);
  const categoryOrder = [...categoryMap.keys()];
  categoryOrder.forEach((cat, i) => {
    console.log(`  ${i + 1}. ${cat} (${categoryMap.get(cat).length} 个)`);
  });
  console.log(`  总计 ${seenAids.size} 个不重复专辑\n`);

  // ========== 开始下载（浏览器保持打开用于图片下载） ==========
  let totalAlbums = 0;
  let totalImages = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const cat of categoryOrder) {
    const albums = categoryMap.get(cat);
    const catDir = path.join(FLAG_OUT, sanitize(cat));
    console.log(`\n===== 分类: ${cat} (${albums.length} 个) =====`);

    for (let i = 0; i < albums.length; i += FLAG_PARALLEL) {
      const batch = albums.slice(i, i + FLAG_PARALLEL);
      const results = await Promise.allSettled(batch.map(async (album) => {
        const albumAid = album.aid;
        let albumTitle = album.title || `aid-${albumAid}`;
        try {
          const apiTitle = await getAlbumTitle(albumAid);
          if (apiTitle) albumTitle = apiTitle;
        } catch (e) {
          // 用书架上的标题
        }

        const albumDir = path.join(catDir, sanitize(albumTitle));
        const shortTitle = albumTitle.length > 35 ? albumTitle.slice(0, 33) + '…' : albumTitle;

        const result = await downloadAlbum(albumAid, albumTitle, albumDir, page);

        return { aid: albumAid, title: albumTitle, shortTitle, result };
      }));

      for (const r of results) {
        if (r.status === 'fulfilled') {
          const { aid, shortTitle, result } = r.value;
          if (result.status === 'skipped') {
            console.log(`  [↻] ${shortTitle}`);
            totalSkipped++;
          } else if (result.status === 'done') {
            console.log(`  [✓] ${shortTitle} (${result.downloaded}/${result.total})`);
            totalAlbums++;
            totalImages += result.downloaded;
          } else if (result.status === 'no-images') {
            console.log(`  [×] ${shortTitle} 无图片`);
            totalFailed++;
          }
        } else {
          const errMsg = r.reason?.message || '未知错误';
          console.log(`  [!] ${errMsg.slice(0, 80)}`);
          totalFailed++;
        }
      }
    }
  }

  // 关闭浏览器
  await context.close();

  // ========== 汇总 ==========
  console.log(`\n\n======== 全部完成 ========`);
  console.log(`输出目录: ${FLAG_OUT}`);
  console.log(`专辑: ${totalAlbums} 个新下载 + ${totalSkipped} 个已存在`);
  console.log(`图片: ${totalImages} 张`);
  if (totalFailed > 0) console.log(`失败: ${totalFailed} 个`);
  } catch (e) {
    console.error(`\n× 脚本异常: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
})();
