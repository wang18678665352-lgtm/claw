/**
 * 拷贝漫画下载完整性校验脚本
 *
 * 对照每章页面的 .comicCount（实际页数）检查本地目录里的图片数量。
 * 缺页的目录会被删除，以便 scrape-copymanga.js 重新下载。
 *
 * 用法:
 *   node scripts/verify-copymanga.js <comic-slug|url> [--start N] [--end N]
 *
 * 示例:
 *   node scripts/verify-copymanga.js grandblue --start 13 --end 78
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const INPUT = args.find(a => !a.startsWith('--')) || '';
const FLAG_OUT = getFlagValue('--output') || 'downloads';

function getFlagValue(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
}

function parseFlag(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx === -1) return defaultVal;
  const val = parseInt(args[idx + 1], 10);
  return isNaN(val) ? defaultVal : val;
}

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
}

function padNum(n, total) {
  return String(n).padStart(String(total).length, '0');
}

function parseInput(input) {
  const urlMatch = input.match(/^(https?:\/\/[^/]+)/);
  const slugMatch = input.match(/comic\/([^/?#]+)/);
  const slug = slugMatch ? slugMatch[1] : input.replace(/[\/?#].*$/, '');
  const domain = urlMatch ? urlMatch[1] : 'https://www.2026copy.com';
  return { slug, domain };
}

(async () => {
  if (!INPUT) {
    console.log('用法: node scripts/verify-copymanga.js <comic-slug|url> [--start N] [--end N]');
    process.exit(1);
  }

  const { slug, domain } = parseInput(INPUT);
  const outRoot = path.join(FLAG_OUT, sanitize(slug));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 获取章节列表（与 scrape-copymanga.js 逻辑一致）
  console.log('获取章节列表...');
  await page.goto(`${domain}/comic/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const rawChapters = await page.evaluate(() => {
    return [...document.querySelectorAll('a[href*="/chapter/"]')]
      .map(a => ({
        label: (a.textContent || '').trim(),
        uuid: a.href.match(/chapter\/([^/?#]+)/)?.[1] || '',
      }))
      .filter(c => c.label && c.uuid);
  });

  const seen = new Map();
  for (const c of rawChapters) {
    if (/^開始閱讀|開始閱讀$/.test(c.label)) continue;
    const existing = seen.get(c.uuid);
    if (!existing || c.label.length > existing.label.length) {
      seen.set(c.uuid, c);
    }
  }
  const chapters = [...seen.values()].reverse();

  if (chapters.length === 0) {
    console.log('× 未找到章节');
    await browser.close();
    process.exit(1);
  }
  console.log(`共 ${chapters.length} 话\n`);

  const startIdx = parseFlag('--start', 1);
  const endIdx = parseFlag('--end', chapters.length);

  let ok = 0;
  let missing = 0;
  let incomplete = 0;
  const bad = [];

  for (let idx = startIdx; idx <= endIdx && idx <= chapters.length; idx++) {
    const chapter = chapters[idx - 1];
    const dirName = `${padNum(idx, chapters.length)}_${sanitize(chapter.label)}`;
    const dir = path.join(outRoot, dirName);

    if (!fs.existsSync(dir)) {
      console.log(`[缺失] ${dirName}`);
      missing++;
      bad.push(dirName);
      continue;
    }

    const localCount = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f)).length;

    let expected = 0;
    try {
      await page.goto(`${domain}/comic/${slug}/chapter/${chapter.uuid}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(1500);
      expected = await page.evaluate(() => {
        const el = document.querySelector('.comicCount');
        const n = parseInt(el?.textContent || '', 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
      });
    } catch (e) {
      console.log(`[跳过] ${dirName} — 页面打开失败: ${e.message}`);
      continue;
    }

    if (expected && localCount >= expected) {
      ok++;
    } else {
      console.log(`[缺页] ${dirName} — 本地 ${localCount} / 实际 ${expected || '?'}`);
      incomplete++;
      bad.push(dirName);
      if (expected) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`       已删除，等待重新下载`);
      }
    }
  }

  console.log(`\n======== 校验完成 ========`);
  console.log(`完整: ${ok} | 缺失: ${missing} | 缺页(已删除): ${incomplete}`);
  if (bad.length > 0) {
    console.log(`\n重新下载命令:`);
    console.log(`  node scripts/scrape-copymanga.js ${slug} --start ${startIdx} --end ${endIdx} --parallel 2`);
  }

  await browser.close();
})();
