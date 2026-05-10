
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const QUERY = process.argv.slice(2).join(' ') || 'cat';
const COUNT = parseInt(process.env.COUNT, 10) || 20;
const ENGINE = process.env.ENGINE || 'google';
const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');

function download(url, referer) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: referer || new URL(url).origin,
      },
      timeout: 15000,
    };
    mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(new URL(res.headers.location, url).href, referer).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  console.log(`搜索: ${QUERY}`);
  console.log(`目标: ${COUNT} 张`);
  console.log(`来源: ${ENGINE === 'google' ? 'Google Images' : 'Bing Images'}\n`);

  const foundUrls = [];

  if (ENGINE === 'google') {
    // ============ Google Images（从页面 HTML 提取源站原图 URL）============
    await page.goto(
      `https://www.google.com/search?q=${encodeURIComponent(QUERY)}&tbm=isch`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForTimeout(3000);

    // 关 cookie 弹窗
    try {
      const btn = page.locator('#L2AGlb, button:has-text("同意"), button:has-text("Accept all")');
      await btn.first().click({ timeout: 3000 });
      await page.waitForTimeout(1000);
    } catch { /* ok */ }

    // 滚动加载更多图片（Google 页面数据越多，能提取到的源站 URL 也越多）
    let staleScrolls = 0;
    let prevCount = 0;
    while (staleScrolls < 8) {
      // 从页面 HTML 中提取源站原图 URL
      const urls = await page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        const found = new Set();
        const re = /"(https?:\/\/[^"]+?\.(?:jpg|jpeg|png|gif|webp)(?:[^"]*?))"/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
          const u = m[1].replace(/\\\//g, '/').replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
          if (
            u.startsWith('http') &&
            !u.includes('encrypted-tbn') &&
            !u.includes('google.com/') &&
            !u.includes('fonts.gstatic') &&
            !u.includes('ytimg.com') &&
            !u.includes('youtube') &&
            !u.includes('data:') &&
            u.length > 50  // 过滤太短的（大概率是图标）
          ) {
            found.add(u);
          }
        }
        return [...found];
      });

      urls.forEach(u => { if (!foundUrls.includes(u)) foundUrls.push(u); });
      const newCount = foundUrls.length;

      if (newCount === prevCount) staleScrolls++;
      else staleScrolls = 0;
      prevCount = newCount;

      console.log(`累计发现 ${foundUrls.length} 个源站图片 URL`);

      if (foundUrls.length >= COUNT * 3) break;

      await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(2000 + Math.random() * 1500);
    }
  } else {
    // ============ Bing Images ============
    await page.goto(
      `https://www.bing.com/images/search?q=${encodeURIComponent(QUERY)}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForTimeout(2000);

    let staleScrolls = 0;
    while (foundUrls.length < COUNT && staleScrolls < 5) {
      const urls = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('img.mimg').forEach(img => {
          const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (src && src.startsWith('http')) results.push(src);
        });
        return results;
      });

      const before = foundUrls.length;
      urls.forEach(u => { if (!foundUrls.includes(u)) foundUrls.push(u); });
      if (foundUrls.length === before) staleScrolls++;
      else staleScrolls = 0;

      console.log(`累计发现 ${foundUrls.length} 张`);

      await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(1500 + Math.random() * 1000);
    }
  }

  const finalUrls = foundUrls.slice(0, COUNT);
  console.log(`\n共提取 ${finalUrls.length} 张图片 URL`);

  if (finalUrls.length === 0) {
    console.log('未找到图片，保存截图检查...');
    await page.screenshot({ path: path.join(__dirname, '..', 'debug.png'), fullPage: true });
    await context.close();
    return;
  }

  // 创建目录
  const dirName = `images-${sanitize(QUERY.slice(0, 20))}`;
  const outDir = path.join(__dirname, '..', dirName);
  fs.mkdirSync(outDir, { recursive: true });

  // 下载
  let downloaded = 0;
  let attempted = 0;
  for (let i = 0; i < finalUrls.length && downloaded < COUNT; i++) {
    const url = finalUrls[i];
    const match = url.replace(/[?#].*$/, '').match(/\.(jpe?g|png|gif|webp)/i);
    const ext = match ? match[1].replace('jpeg', 'jpg') : 'jpg';
    const filename = `img${String(downloaded + 1).padStart(3, '0')}.${ext}`;
    const dest = path.join(outDir, filename);

    process.stdout.write(`[${downloaded + 1}/${COUNT}] ${filename} ... `);
    attempted++;

    try {
      const data = await download(url);
      if (data.length < 2000) {
        // 太小的可能是错误页，用源站域名做 Referer 重试一次
        const retryData = await download(url, new URL(url).origin);
        if (retryData.length > data.length && retryData.length >= 2000) {
          fs.writeFileSync(dest, retryData);
          downloaded++;
          console.log(`✓ (${(retryData.length / 1024).toFixed(0)}KB)`);
        } else {
          console.log(`× 太小 (${data.length} bytes)`);
        }
      } else {
        fs.writeFileSync(dest, data);
        downloaded++;
        console.log(`✓ (${(data.length / 1024).toFixed(0)}KB)`);
      }
    } catch (e) {
      console.log(`× ${e.message}`);
    }
  }

  console.log(`\n完成: ${dirName}/  (${downloaded}/${attempted} 尝试, 目标 ${COUNT})`);
  await context.close();
})();

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim();
}
