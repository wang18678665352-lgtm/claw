/**
 * 拷贝漫画 (2026copy.com) 下载脚本
 *
 * 用法:
 *   node scripts/scrape-copymanga.js <comic-slug|url> [选项]
 *
 * 示例:
 *   node scripts/scrape-copymanga.js jinyuqi                   # 下载全部章节
 *   node scripts/scrape-copymanga.js jinyuqi --latest 5        # 下载最新 5 话
 *   node scripts/scrape-copymanga.js jinyuqi --start 3 --end 8 # 下载第 3~8 话
 *   node scripts/scrape-copymanga.js jinyuqi --parallel 3       # 3 个浏览器并行下载
 *   node scripts/scrape-copymanga.js jinyuqi --parallel 3 --latest 10
 *
 * 环境变量:
 *   CONCURRENCY=3   每浏览器内图片并行下载数（默认 3）
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ========== 参数解析 ==========
const args = process.argv.slice(2);
const INPUT = args.find(a => !a.startsWith('--')) || '';
const FLAG_START = parseFlag('--start', 1);
const FLAG_END = parseFlag('--end');
const FLAG_LATEST = parseFlag('--latest');
const FLAG_ALL = args.includes('--all');
const FLAG_PARALLEL = parseFlag('--parallel', 1);
const FLAG_OUT = getFlagValue('--output') || 'downloads';
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 3;

function parseFlag(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx === -1) return defaultVal;
  const val = parseInt(args[idx + 1], 10);
  return isNaN(val) ? defaultVal : val;
}

function getFlagValue(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}

// ========== 工具函数 ==========

/** 解析输入（支持完整 URL 或直接 slug），返回 { slug, domain } */
function parseInput(input) {
  const urlMatch = input.match(/^(https?:\/\/[^/]+)/);
  const slugMatch = input.match(/comic\/([^/?#]+)/);
  const slug = slugMatch ? slugMatch[1] : input.replace(/[\/?#].*$/, '');
  const domain = urlMatch ? urlMatch[1] : 'https://www.2026copy.com';
  return { slug, domain };
}

/** 下载文件（socket 挂起时超时重试，避免整个实例卡死） */
function download(url, dest, referer, retries = 2) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: referer,
      },
      timeout: 30000,
    };
    const req = mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).href, dest, referer, retries).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      const onErr = (e) => { try { file.close(); fs.unlinkSync(dest); } catch { /* ok */ } reject(e); };
      file.on('error', onErr);
      res.on('error', onErr);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      if (retries > 0) {
        setTimeout(() => download(url, dest, referer, retries - 1).then(resolve).catch(reject), 2000);
      } else {
        reject(new Error('下载超时'));
      }
    });
  });
}

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
}

function padNum(n, total) {
  return String(n).padStart(String(total).length, '0');
}

// ========== 滚动加载 + 提取图片 ==========

/** 智能滚动到底部，等待懒加载图片全部出现，返回所有图片 URL */
async function scrollAndExtractImages(page) {
  // 先等容器出现
  await page.waitForTimeout(1500);

  // 站点提供本章总页数（.comicCount），作为滚动停止的硬依据
  const expected = await page.evaluate(() => {
    const el = document.querySelector('.comicCount');
    const n = parseInt(el?.textContent || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });

  // 滚动过程中持续累积图片 URL（去 query 去重，排除广告/静态资源）
  const seen = new Map();
  const collect = async () => {
    const urls = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('img').forEach(img => {
        const url = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (
          url.startsWith('http') &&
          !url.includes('data:image') &&
          !url.includes('svg') &&
          !url.includes('/ads/') &&
          !url.includes('/static/') &&
          url.length > 30
        ) {
          results.push(url);
        }
      });
      return results;
    });
    urls.forEach(u => seen.set(u.split('?')[0], u));
  };

  // 策略：使用 PageDown 键逐屏滚动，每次等待新图片加载
  // 比 scrollBy 更接近真实用户行为，更容易触发懒加载
  let staleSteps = 0;
  let prevSize = 0;

  for (let s = 0; s < 200; s++) {
    // 按 PageDown 翻一屏
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(500);

    await collect();

    if (seen.size === prevSize) {
      staleSteps++;
    } else {
      staleSteps = 0;
    }
    prevSize = seen.size;

    // 已知总页数且已收集齐：提前结束
    if (expected && seen.size >= expected) break;

    // 到最底部后再多滚几次确保触发所有懒加载
    const atBottom = await page.evaluate(
      () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 50
    );

    if (atBottom) {
      if (staleSteps >= 8) break;
      // 到底了但还没稳定，小等一会
      await page.waitForTimeout(800);
    }
  }

  // 最终收集：等所有图片稳定后再收一次
  await page.waitForTimeout(1000);
  await collect();

  return [...seen.values()];
}

// ========== 单浏览器实例的章节下载器 ==========

async function downloadChapters(chapters, startNum, totalNum, slug, domain, outRoot, instanceId) {
  const referer = `${domain}/`;
  let downloaded = 0;
  let failed = 0;

  // 每个实例使用独立 profile 目录（避免冲突）
  const profileDir = path.join(__dirname, '..', `.browser-profile-${instanceId}`);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
  });
  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    for (let ci = 0; ci < chapters.length; ci++) {
      const chapter = chapters[ci];
      const chapterNum = startNum + ci;
      const chapterDir = path.join(outRoot, `${padNum(chapterNum, totalNum)}_${sanitize(chapter.label)}`);
      const chapterUrl = `${domain}/comic/${slug}/chapter/${chapter.uuid}`;

      console.log(`[实例${instanceId}] [${padNum(chapterNum, totalNum)}/${totalNum}] ${chapter.label}`);

      // 检查是否已下载
      if (fs.existsSync(chapterDir) && fs.readdirSync(chapterDir).length > 0) {
        console.log(`[实例${instanceId}]   已存在, 跳过`);
        continue;
      }

      // 加载章节页
      console.log(`[实例${instanceId}]   打开 ${chapterUrl}`);
      try {
        await page.goto(chapterUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e) {
        console.log(`[实例${instanceId}]   × 加载失败: ${e.message}`);
        failed++;
        continue;
      }

      // 滚动到底部提取所有图片
      const imgUrls = await scrollAndExtractImages(page);

      // 过滤：优先保留漫画图片（按域名特征），但保留所有候选
      const mangaUrls = imgUrls.filter(url => {
        // 包含常见漫画图片 CDN 关键词
        return /mangafunb|manga|comic|chapter|images|pic|cdn/i.test(url);
      });

      // 如果按特征过滤后太少，就用全部
      const finalUrls = mangaUrls.length >= 3 ? mangaUrls : imgUrls;

      if (finalUrls.length === 0) {
        console.log(`[实例${instanceId}]   × 未找到图片 (共 ${imgUrls.length} 个候选)`);
        // 截图帮助调试
        try {
          await page.screenshot({ path: path.join(__dirname, '..', `debug-${instanceId}.png`), fullPage: true });
        } catch { /* ok */ }
        failed++;
        continue;
      }

      console.log(`[实例${instanceId}]   共 ${finalUrls.length} 页`);

      fs.mkdirSync(chapterDir, { recursive: true });

      let chapterOk = 0;
      let chapterFail = 0;

      const tasks = finalUrls.map((url, pi) => {
        const ext = url.match(/\.(webp|jpe?g|png|gif)/i)?.[1]?.replace(/jpeg/i, 'jpg') || 'jpg';
        const filename = `${padNum(pi + 1, finalUrls.length)}.${ext}`;
        const dest = path.join(chapterDir, filename);
        return { url, dest, pi };
      });

      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async ({ url, dest, pi }) => {
          try {
            await download(url, dest, referer);
            const stat = fs.statSync(dest);
            if (stat.size < 1000) {
              fs.unlinkSync(dest);
              throw new Error(`太小(${stat.size}b)`);
            }
            chapterOk++;
          } catch (e) {
            try { fs.unlinkSync(dest); } catch { /* ok */ }
            chapterFail++;
          }
        }));
      }

      console.log(`[实例${instanceId}]   结果: ${chapterOk}/${tasks.length} 成功`);

      if (chapterOk === 0) {
        try { fs.rmdirSync(chapterDir); } catch { /* ok */ }
      }

      downloaded += chapterOk;
      failed += chapterFail;
    }
  } finally {
    await context.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ok */ }
  }

  return { downloaded, failed };
}

// ========== 主流程 ==========

(async () => {
  if (!INPUT) {
    console.log('用法: node scripts/scrape-copymanga.js <comic-slug|url> [选项]');
    console.log('');
    console.log('选项:');
    console.log('  --latest N    下载最新 N 话');
    console.log('  --start N     起始话数（默认 1）');
    console.log('  --end N       结束话数');
    console.log('  --all         下载全部（等价于 --start 1）');
    console.log('  --parallel N  并行浏览器实例数（默认 1）');
    console.log('  --output DIR  输出目录（默认 ./downloads）');
    console.log('  --list        只列出章节（带序号）不下载');
    console.log('');
    console.log('示例:');
    console.log('  node scripts/scrape-copymanga.js jinyuqi --latest 5');
    console.log('  node scripts/scrape-copymanga.js jinyuqi --parallel 3 --latest 12');
    console.log('  node scripts/scrape-copymanga.js jinyuqi --parallel 4');
    process.exit(1);
  }

  const { slug, domain } = parseInput(INPUT);
  const baseUrl = `${domain}/comic/${slug}`;
  const outRoot = path.join(FLAG_OUT, sanitize(slug));

  console.log(`漫画: ${baseUrl}`);
  console.log(`域名: ${domain}`);
  console.log(`输出: ${outRoot}`);
  console.log(`并行实例: ${FLAG_PARALLEL}\n`);

  // ========== 获取章节列表（只用一个浏览器） ==========
  const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
  });
  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  console.log('获取章节列表...');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const rawChapters = await page.evaluate(() => {
    return [...document.querySelectorAll('a[href*="/chapter/"]')]
      .map(a => ({
        label: (a.textContent || '').trim(),
        uuid: a.href.match(/chapter\/([^/?#]+)/)?.[1] || '',
      }))
      .filter(c => c.label && c.uuid);
  });

  // 去重和过滤
  const seen = new Map();
  for (const c of rawChapters) {
    if (/^開始閱讀|開始閱讀$/.test(c.label)) continue;
    const existing = seen.get(c.uuid);
    if (!existing || c.label.length > existing.label.length) {
      seen.set(c.uuid, c);
    }
  }
  const pagesOrder = [...seen.values()];
  const chapters = [...pagesOrder].reverse();

  if (chapters.length === 0) {
    console.log('× 未找到章节');
    await context.close();
    process.exit(1);
  }

  console.log(`共 ${chapters.length} 话（去重后）\n`);

  // --list：只打印章节列表（带下载序号）后退出，不下载
  if (args.includes('--list')) {
    chapters.forEach((c, i) => {
      console.log(`  ${String(i + 1).padStart(String(chapters.length).length, ' ')}. ${c.label}`);
    });
    await context.close();
    return;
  }

  // ========== 确定下载范围 ==========
  let targetChapters;
  let startIdx = 1;
  let endIdx = chapters.length;

  if (FLAG_LATEST) {
    const latest = pagesOrder.slice(0, Math.min(FLAG_LATEST, pagesOrder.length));
    targetChapters = [...latest].reverse();
    startIdx = chapters.length - targetChapters.length + 1;
    endIdx = chapters.length;
  } else if (FLAG_ALL) {
    startIdx = 1;
    endIdx = chapters.length;
    targetChapters = chapters.slice(startIdx - 1, endIdx);
  } else if (FLAG_START > 1) {
    startIdx = FLAG_START;
    endIdx = FLAG_END || chapters.length;
    targetChapters = chapters.slice(startIdx - 1, endIdx);
  } else {
    targetChapters = chapters.slice(0, endIdx);
  }

  // 关闭列表浏览器
  await context.close();

  console.log(`下载范围: 第 ${startIdx} ~ ${endIdx} 话 (共 ${targetChapters.length} 话)`);
  targetChapters.forEach((c, i) => {
    console.log(`  ${padNum(startIdx + i, chapters.length)}. ${c.label}`);
  });
  console.log('');

  // ========== 并行下载 ==========
  const parallel = Math.min(FLAG_PARALLEL, targetChapters.length);

  if (parallel <= 1) {
    const result = await downloadChapters(targetChapters, startIdx, chapters.length, slug, domain, outRoot, 1);
    console.log(`\n======== 完成 ========`);
    console.log(`目录: ${outRoot}`);
    console.log(`结果: ${result.downloaded} 张图片 / ${targetChapters.length} 话`);
    if (result.failed > 0) console.log(`失败: ${result.failed} 张`);
    return;
  }

  // 分割章节到各组（连续分块，保证每组内编号连续，与 groupStart 计算一致）
  const groups = [];
  const perGroup = Math.ceil(targetChapters.length / parallel);
  for (let i = 0; i < targetChapters.length; i += perGroup) {
    groups.push(targetChapters.slice(i, i + perGroup));
  }

  // 计算每个组的起始编号
  console.log(`启动 ${parallel} 个浏览器实例并行下载...\n`);
  const promises = groups.map((group, gi) => {
    let groupStart = startIdx;
    for (let g = 0; g < gi; g++) {
      groupStart += groups[g].length;
    }
    return downloadChapters(group, groupStart, chapters.length, slug, domain, outRoot, gi + 1);
  });

  const results = await Promise.allSettled(promises);

  // ========== 汇总 ==========
  let totalDownloaded = 0;
  let totalFailed = 0;
  let instanceErrors = 0;

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      totalDownloaded += r.value.downloaded;
      totalFailed += r.value.failed;
      console.log(`[实例${i + 1}] 完成: ${r.value.downloaded} 张图片`);
    } else {
      instanceErrors++;
      console.log(`[实例${i + 1}] × 异常: ${r.reason?.message || '未知错误'}`);
    }
  });

  console.log(`\n======== 完成 ========`);
  console.log(`目录: ${outRoot}`);
  console.log(`结果: ${totalDownloaded} 张图片 / ${targetChapters.length} 话`);
  if (totalFailed > 0) console.log(`失败: ${totalFailed} 张`);
  if (instanceErrors > 0) console.log(`异常实例: ${instanceErrors} 个`);
})();
