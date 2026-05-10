const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PAGE_URL = process.argv[2];
if (!PAGE_URL || !PAGE_URL.includes('bilibili.com/bangumi/play/')) {
  console.error('用法: node scripts/scrape-bilibili-bangumi.js <番剧播放页URL> [集数限制]');
  console.error('示例: node scripts/scrape-bilibili-bangumi.js https://www.bilibili.com/bangumi/play/ss44818');
  console.error('       node scripts/scrape-bilibili-bangumi.js https://www.bilibili.com/bangumi/play/ss44818 3');
  process.exit(1);
}

const AUTH_FILE = path.join(__dirname, '..', '.auth', 'bilibili.json');
if (!fs.existsSync(AUTH_FILE)) {
  console.error('❌ 未检测到登录状态。请先运行:');
  console.error('   node scripts/bilibili-login.js');
  process.exit(1);
}

// 从 URL 提取 season_id (ssXXX) 或 ep_id (epXXX)
const ssMatch = PAGE_URL.match(/ss(\d+)/);
const epMatch = PAGE_URL.match(/ep(\d+)/);
const SEASON_ID = ssMatch ? ssMatch[1] : null;
const INITIAL_EP_ID = epMatch ? epMatch[1] : null;

(async () => {
  console.log('启动浏览器...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: AUTH_FILE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // ====== 获取登录 cookies (给后面直连下载用) ======
  let apiCookies = '';
  try {
    const authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    if (authData.cookies) {
      apiCookies = authData.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
  } catch {}

  // ====== 获取剧集信息 ======
  const epListUrl = SEASON_ID
    ? `https://api.bilibili.com/pgc/view/web/ep/list?season_id=${SEASON_ID}`
    : null;

  let seasonTitle = '';
  let episodes = [];

  if (epListUrl) {
    console.log('获取剧集列表...');
    await page.goto(`https://www.bilibili.com/bangumi/play/ss${SEASON_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const epListData = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        return await res.json();
      } catch { return null; }
    }, epListUrl);

    // 从页面标题提取番剧名（如 "邻家的天使同学-番剧-全集-..."）
    seasonTitle = await page.title().then(t => t.replace(/-番剧.*$/, '').replace(/-全集.*$/, '').trim()).catch(() => '');

    if (epListData?.code === 0) {
      const r = epListData.result;
      const rawEps = r.episodes || [];
      episodes = rawEps.map(e => ({
        epId: e.ep_id,
        aid: e.aid,
        cid: e.cid,
        title: e.long_title || e.title || '',
        cover: e.cover || '',
        badge: e.badge || '',
        shareUrl: e.share_url || '',
        badgeType: e.badge_type,
      }));
      console.log(`  番剧: ${seasonTitle}`);
      console.log(`  剧集数: ${episodes.length}`);
    } else {
      console.log('  获取剧集列表失败，response:', JSON.stringify(epListData).slice(0, 200));
    }
  }

  if (episodes.length === 0 && INITIAL_EP_ID) {
    episodes = [{ epId: parseInt(INITIAL_EP_ID), aid: 0, cid: 0, title: 'EP' + INITIAL_EP_ID }];
    seasonTitle = `番剧 EP${INITIAL_EP_ID}`;
  }

  if (episodes.length === 0) {
    console.log('❌ 无法获取剧集列表');
    await browser.close();
    process.exit(1);
  }

  // ====== 筛选要下载的集数 ======
  const limit = parseInt(process.argv[3], 10) || episodes.length;
  // 默认从第一集开始下（免费集在前），如果想从最后一集开始可传负数
  const toDownload = episodes.slice(0, limit);

  // ====== 创建输出目录 ======
  const dirName = `bangumi-${sanitize((seasonTitle || String(PAGE_URL)).slice(0, 30))}`;
  const outDir = path.join(__dirname, '..', dirName);
  fs.mkdirSync(outDir, { recursive: true });

  // ====== 下载封面 ======
  if (episodes[0]?.cover) {
    console.log('\n下载封面...');
    try {
      const coverUrl = episodes[0].cover.startsWith('http') ? episodes[0].cover : 'https:' + episodes[0].cover;
      const ext = coverUrl.match(/\.(jpe?g|png|webp)/i)?.[1] || 'jpg';
      await downloadFile(coverUrl, path.join(outDir, `cover.${ext}`), PAGE_URL);
      console.log('  封面已保存');
    } catch (e) {
      console.log('  封面下载失败:', e.message);
    }
  }

  // ====== 逐个下载剧集 ======
  // 对于每一集，打开播放页用 pgc/player/web/playurl 获取非 DRM DASH 流
  for (let i = 0; i < toDownload.length; i++) {
    const ep = toDownload[i];
    const epTitle = ep.title || `EP${ep.epId}`;
    const epFile = path.join(outDir, `${sanitize(epTitle)}.mp4`);

    // 跳过已下载的
    if (fs.existsSync(epFile)) {
      console.log(`\n[${i + 1}/${toDownload.length}] ${epTitle} — 已存在，跳过`);
      continue;
    }

    console.log(`\n[${i + 1}/${toDownload.length}] ${epTitle} (ep_id=${ep.epId})`);

    try {
      const epUrl = `https://www.bilibili.com/bangumi/play/ep${ep.epId}`;
      const dash = await getDashForEpisode(page, ep.epId, ep.aid, ep.cid);


      if (!dash || !dash.video?.length || !dash.audio?.length) {
        console.log(`  ✗ 无法获取播放流 (需要大会员?)`);
        continue;
      }

      // 选最高画质
      const bestVideo = dash.video[0];
      const bestAudio = dash.audio[0];

      console.log(`  画质: ${bestVideo.width}x${bestVideo.height} ${bestVideo.codecs}`);

      const videoFile = path.join(outDir, `${sanitize(epTitle)}_video.m4s`);
      const audioFile = path.join(outDir, `${sanitize(epTitle)}_audio.m4s`);

      await downloadFile(bestVideo.baseUrl || bestVideo.base_url, videoFile, epUrl);
      await downloadFile(bestAudio.baseUrl || bestAudio.base_url, audioFile, epUrl);

      console.log(`  合并音视频...`);
      await mergeFiles(videoFile, audioFile, epFile);
      console.log(`  ✓ 完成`);
    } catch (e) {
      console.log(`  ✗ 错误: ${e.message}`);
    }
  }

  // ====== 生成摘要 ======
  const md = [
    `# ${seasonTitle || '番剧'}`,
    '',
    `> 来源: ${PAGE_URL}`,
    '',
    `## 剧集列表`,
    '',
    ...episodes.map((e, i) => `| ${i + 1} | ${e.title || '未知'} | ${e.badge || ''} |`),
    '',
    `## 下载状态`,
    '',
    ...toDownload.map(e => {
      const f = path.join(outDir, `${sanitize(e.title || `EP${e.epId}`)}.mp4`);
      return `- ${e.title || `EP${e.epId}`} — ${fs.existsSync(f) ? '已下载 ✓' : '未下载 ✗'}`;
    }),
    '',
  ];
  fs.writeFileSync(path.join(outDir, 'article.md'), md.join('\n'), 'utf-8');
  console.log(`\n📄 摘要已保存: ${dirName}/article.md`);

  await browser.close();
  console.log('全部完成。');
})();

/**
 * 用 pgc/player/web/playurl 接口获取非 DRM 的 DASH 流
 * 注意 ogv/player/pre/check/drm 会强制 Widevine 加密，必须避开。
 */
async function getDashForEpisode(page, epId, aid, cid) {
  const epUrl = `https://www.bilibili.com/bangumi/play/ep${epId}`;
  await page.goto(epUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // 先试 pgc/player/web/playurl（番剧专用，ep_id 维度）
  const dash = await page.evaluate(async ({ epId, aid, cid }) => {
    // 方案 A: pgc 接口 (ep_id)
    let url = `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${epId}&qn=80&fnval=4048`;
    let res = await fetch(url, { credentials: 'include' });
    let json = await res.json();
    if (json.code === 0 && json.data?.dash?.video?.length) {
      return json.data.dash;
    }

    // 方案 B: 普通视频接口 (aid + cid)，作为 fallback
    if (aid && cid) {
      url = `https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}&qn=80&fnval=4048`;
      res = await fetch(url, { credentials: 'include' });
      json = await res.json();
      if (json.code === 0 && json.data?.dash?.video?.length) {
        return json.data.dash;
      }
    }

    return null;
  }, { epId, aid, cid });

  return dash;
}

/**
 * 下载文件（支持重定向、断点续传、自动重试）
 */
function downloadFile(src, dest, referer) {
  return retry(() => doDownload(src, dest, referer), 3);
}

async function retry(fn, maxAttempts) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const isLast = i === maxAttempts - 1;
      if (isLast) throw e;
      console.log(`  连接断开，第${i + 2}次重试... (${e.message})`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

function doDownload(src, dest, referer) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(src);
    const mod = src.startsWith('https') ? https : require('http');
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        Referer: referer || 'https://www.bilibili.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 600000,
    };
    mod.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        doDownload(res.headers.location, dest, referer).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'], 10);
      let downloaded = 0;
      let lastPct = -1;
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (total) {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            process.stdout.write(`\r  下载: ${pct}% (${fmtSize(downloaded)}/${fmtSize(total)})`);
          }
        }
      });
      file.on('finish', () => {
        process.stdout.write('\n');
        file.close();
        resolve();
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * ffmpeg 合并音视频
 */
function mergeFiles(videoFile, audioFile, outputFile) {
  return new Promise((resolve, reject) => {
    const { execSync } = require('child_process');
    // 优先使用 npm 安装的 ffmpeg，否则用系统 PATH 中的 ffmpeg
    let ffmpegPath = 'ffmpeg';
    try {
      ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    } catch {}
    try {
      execSync(
        `"${ffmpegPath}" -y -i "${videoFile}" -i "${audioFile}" -c copy "${outputFile}"`,
        { stdio: 'ignore', timeout: 300000 }
      );
      // 清理分片
      fs.unlinkSync(videoFile);
      fs.unlinkSync(audioFile);
      resolve();
    } catch {
      reject(new Error('ffmpeg 合并失败，保留 m4s 文件供手动合并'));
    }
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function sanitize(s) {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim();
}
