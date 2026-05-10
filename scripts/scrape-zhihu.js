const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const URL = process.argv[2];
if (!URL) {
  console.error('用法: node scripts/scrape-zhihu.js <知乎文章URL>');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
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

  try {
    await page.waitForSelector('article, .RichText, .Post-RichText, .css-1l65c5g', {
      timeout: 15000,
    });
  } catch {
    console.log('未检测到典型正文容器，继续尝试提取...');
  }

  // 滚动触发懒加载
  await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) {
      window.scrollBy(0, 800);
      await new Promise(r => setTimeout(r, 800));
    }
  });
  await page.waitForTimeout(2000);

  // 提取信息
  const article = await page.evaluate(() => {
    const title =
      document.querySelector('h1')?.textContent?.trim() ||
      document.title?.replace(' - 知乎', '').trim() ||
      '未找到标题';

    const authorEl =
      document.querySelector('[itemprop="author"]') ||
      document.querySelector('.AuthorInfo-name');
    const author = authorEl?.textContent?.trim() || '未知作者';

    const contentEl =
      document.querySelector('article') ||
      document.querySelector('.RichText') ||
      document.querySelector('.Post-RichText');

    // 把正文里的图片 src 替换为本地文件名标记，方便后续替换
    let html = contentEl?.innerHTML || '';
    const images = [];
    const seen = new Set();

    // 匹配正文中所有 img 标签，收集 src
    html = html.replace(/<img[^>]+>/g, (tag) => {
      const srcMatch = tag.match(/src="([^"]+)"/) || tag.match(/data-src="([^"]+)"/);
      if (!srcMatch) return tag;
      const src = srcMatch[1];
      if (seen.has(src)) return tag;
      seen.add(src);
      const ext = src.replace(/[?#].*$/, '').match(/\.(jpe?g|png|gif|webp|svg)/i);
      const filename = `img${String(images.length + 1).padStart(2, '0')}.${ext ? ext[1] : 'jpg'}`;
      images.push({ src, filename });
      return tag.replace(/src="[^"]+"/, `src="images/${filename}"`);
    });

    const text = contentEl?.innerText?.trim() || '未提取到正文';

    // 把 body 里所有文本中的 img 引用也清理出来（innerHTML 的替换可能漏掉 data-src）
    const allImgs = [...contentEl?.querySelectorAll('img') || []];
    if (images.length === 0 && allImgs.length > 0) {
      allImgs.forEach((img, i) => {
        const src = img.src || img.dataset?.src;
        if (src && !seen.has(src)) {
          seen.add(src);
          const ext = src.replace(/[?#].*$/, '').match(/\.(jpe?g|png|gif|webp|svg)/i);
          const filename = `img${String(i + 1).padStart(2, '0')}.${ext ? ext[1] : 'jpg'}`;
          images.push({ src, filename });
          // 在 text 中追加提示
        }
      });
    }

    return { title, author, text, images, html };
  });

  console.log(`\n标题: ${article.title}`);
  console.log(`作者: ${article.author}`);
  console.log(`图片: ${article.images.length} 张`);
  console.log(`正文字数: ${article.text.length} 字`);

  // 创建输出目录
  const dirName = `zhihu-${sanitize(article.title.slice(0, 30))}`;
  const outDir = path.join(__dirname, '..', dirName);
  const imgDir = path.join(outDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  // 下载图片
  let downloaded = 0;
  for (const img of article.images) {
    const dest = path.join(imgDir, img.filename);
    try {
      await download(img.src, dest, URL);
      downloaded++;
      process.stdout.write(`\r下载图片: ${downloaded}/${article.images.length}`);
    } catch (e) {
      console.log(`\n  跳过: ${img.filename} (${e.message})`);
    }
  }
  if (article.images.length > 0) console.log('');

  // 构建图片在 markdown 中的占位（基于已下载的图片）
  let mdContent = article.text;
  for (const img of article.images) {
    const dest = path.join(imgDir, img.filename);
    if (fs.existsSync(dest)) {
      // 在文本中，URL 可能已被替换，这里简单追加图片引用
    }
  }

  // 保存 Markdown
  const md = [
    `# ${article.title}`,
    '',
    `> 作者: ${article.author}`,
    `> 来源: ${URL}`,
    '',
    article.text,
    '',
    '---',
    '',
    ...article.images
      .filter(img => fs.existsSync(path.join(imgDir, img.filename)))
      .map(img => `![${img.filename}](images/${img.filename})`),
  ].join('\n');

  fs.writeFileSync(path.join(outDir, 'article.md'), md, 'utf-8');
  console.log(`\n已保存到: ${dirName}/`);
  console.log(`  - article.md (${article.text.length} 字)`);
  console.log(`  - images/ (${downloaded} 张图)`);

  await browser.close();
  console.log('完成。');
})();

function download(src, dest, referer) {
  return new Promise((resolve, reject) => {
    const protocol = src.startsWith('https') ? https : http;
    const req = protocol.get(
      src,
      {
        headers: {
          Referer: referer,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 15000,
      },
      (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location, dest, referer).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('超时'));
    });
  });
}

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim();
}
