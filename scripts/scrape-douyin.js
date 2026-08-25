/**
 * 抖音无水印视频下载脚本（Node + Playwright）
 *
 * 移植自 videohuman/vh_core/stages/download.py 的思路：
 *   ① 输入取 modal_id：分享文本抽短链 → 302 跳转 / 短链 / modal_id 直链均可
 *   ② playwright 开浏览器（带登录态）打开视频页，拦截 aweme detail API 取播放地址
 *      （纯 fetch 会被反爬 JS 壳拦死，2026-08 起 RENDER_DATA 服务端渲染已下线）
 *   ③ fetch 流式下载（Referer + UA，不需要 cookie）
 *
 * 用法:
 *   node scripts/scrape-douyin.js login                     # 打开浏览器登录抖音并保存登录态
 *   node scripts/scrape-douyin.js "<分享文本|短链|视频链接>"  # 下载单个视频
 *   node scripts/scrape-douyin.js --file urls.txt           # 批量下载（每行一个链接）
 *   node scripts/scrape-douyin.js "https://v.douyin.com/xxx" --out downloads --headful
 *
 * 示例:
 *   node scripts/scrape-douyin.js "8.43 复制打开抖音 ... https://v.douyin.com/AbCdEfG/"
 *   node scripts/scrape-douyin.js "https://www.douyin.com/video/7312345678901234567"
 *   node scripts/scrape-douyin.js --file share.txt
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const AUTH_FILE = path.join(__dirname, '..', '.auth', 'douyin.json');
const UA = (
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36'
);
const DETAIL_API = 'aweme/v1/web/aweme/detail';
const DETAIL_WAIT_TIMEOUT = 45; // 浏览器内等详情 API 响应的上限（秒）

// 反检测 init script（照搬 reference）：去 webdriver 痕迹、伪装插件/语言/屏幕、覆盖权限查询
const STEALTH_JS = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
  parameters.name === 'notifications'
    ? Promise.resolve({ state: Notification.permission })
    : originalQuery(parameters)
);
Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
`;

const CHROME_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-extensions',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

// ============ 参数解析 ============

const args = process.argv.slice(2);

/**
 * 解析命令行参数。返回 {
 *   login:  是否触发登录模式,
 *   headful:是否非无头,
 *   out:    输出目录,
 *   file:   批量链接文件,
 *   inputs: 位置参数（真正的输入链接）
 * }。
 */
function parseArgs(argv) {
  const flags = {};
  const inputs = [];
  const valueFlags = new Set(['--out', '--file']);
  const boolFlags = new Set(['--headful', '--login']);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      flags[a.slice(2)] = argv[++i] || '';
    } else if (boolFlags.has(a)) {
      flags[a.slice(2)] = true;
    } else if (a.startsWith('--')) {
      // 未知 flag 跳过，避免把其值误当输入
    } else if (a === 'login') {
      flags.login = true;
    } else if (a.startsWith('-')) {
      // 单个短横线，忽略
    } else {
      inputs.push(a);
    }
  }
  return {
    login: !!flags.login,
    headful: !!flags.headful,
    out: flags.out || 'downloads',
    file: flags.file || null,
    inputs,
  };
}

// ============ 工具函数 ============

/** 去掉文件名非法字符 */
function sanitize(s) {
  return String(s).replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80) || 'unknown';
}

/** 从分享文本 / 短链 / 视频直链中抽取 modal_id（视频 ID），无需 cookie（本函数异步，内部会跟随短链） */
async function parseModal(input) {
  const text = String(input || '').trim();
  // 形态 1：modal_id 直链 或 /video/<id> 直链
  const m = text.match(/modal_id=(\d+)/) || text.match(/douyin\.com\/video\/(\d+)/);
  if (m) return m[1];
  // 形态 2：分享文本或短链，跟随 302 重定向取最终 URL
  const short = text.match(/https?:\/\/v\.douyin\.com\/[\w\-]+\/?/);
  if (!short) {
    throw new Error(`无法从输入中识别抖音链接: ${text.slice(0, 80)}`);
  }
  let finalUrl = short[0];
  try {
    const res = await fetch(finalUrl, { redirect: 'follow', headers: { 'User-Agent': UA } });
    finalUrl = res.url || finalUrl;
  } catch (e) {
    throw new Error(`短链跳转失败（检查网络）: ${e.message}`);
  }
  const m2 = finalUrl.match(/douyin\.com\/video\/(\d+)/) || finalUrl.match(/modal_id=(\d+)/);
  if (m2) return m2[1];
  throw new Error(`短链跳转后未识别视频 ID，最终 URL: ${finalUrl}`);
}

// ============ 浏览器抓取播放地址 ============

/**
 * 打开视频页，拦截 aweme detail API，返回 { play_url, title }。
 * 结构差异兼容处理：优先默认播放流，其次码率列表；url_list[0] 即 CDN 地址。
 */
async function getPlayInfo(page, modalId) {
  let detail = null;
  const onResponse = async resp => {
    if (!resp.url().includes(DETAIL_API)) return;
    try {
      const body = await resp.json();
      if (body && body.aweme_detail) detail = body.aweme_detail;
    } catch {
      /* 非 JSON 响应直接忽略 */
    }
  };
  page.on('response', onResponse);

  await page.goto(`https://www.douyin.com/video/${modalId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  const deadline = Date.now() + DETAIL_WAIT_TIMEOUT * 1000;
  while (!detail && Date.now() < deadline) {
    await page.waitForTimeout(1000);
  }
  page.off('response', onResponse);

  if (!detail) {
    throw new Error(
      '浏览器未抓到视频详情 —— 登录态可能失效（重新运行 login）、链接无效或被风控，请稍后重试'
    );
  }

  const video = detail.video || {};
  const candidates = [video.play_addr];
  for (const b of video.bit_rate || []) candidates.push(b.play_addr);

  let playUrl = '';
  for (const c of candidates) {
    const urls = (c || {}).url_list || [];
    if (urls.length) {
      playUrl = urls[0];
      break;
    }
  }
  if (!playUrl) {
    throw new Error('详情接口结构与预期不符（抖音可能改版）：video 下无可用 play_addr');
  }
  if (!/^https?:\/\//.test(playUrl)) playUrl = 'https://' + playUrl;

  return { play_url: playUrl, title: detail.desc || '' };
}

// ============ 文件下载 ============

/** 流式下载（Referer + UA，无需 cookie）。空文件会删掉并报错（播放地址可能已过期）。 */
async function downloadFile(url, outPath) {
  const headers = { Referer: 'https://www.douyin.com/', 'User-Agent': UA };
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 HTTP ${res.status}`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fileStream = fs.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    const reader = Readable.fromWeb(res.body);
    reader.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', resolve);
    reader.pipe(fileStream);
  });
  const stat = fs.statSync(outPath);
  if (stat.size === 0) {
    fs.rmSync(outPath, { force: true });
    throw new Error('下载到空文件，播放地址可能已过期');
  }
  return stat.size;
}

// ============ 登录态 ============

const LOGIN_URL = 'https://www.douyin.com/';
const LOGIN_WAIT_TIMEOUT = 300; // 等用户完成登录的上限（秒）

/**
 * 打开 headed 浏览器引导用户登录，保存 `.auth/douyin.json`。
 * 判登录成功：context 中出现 douyin.com 域的 sessionid / sessionid_ss cookie。
 */
async function doLogin() {
  const browser = await chromium.launch({ headless: false, args: CHROME_ARGS });
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    await context.addInitScript(STEALTH_JS);
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    console.log('\n浏览器已打开抖音，请扫码 / 手机号验证登录，登录成功后将自动保存登录态。');
    console.log(`最长等待 ${LOGIN_WAIT_TIMEOUT} 秒...\n`);

    const deadline = Date.now() + LOGIN_WAIT_TIMEOUT * 1000;
    let loggedIn = false;
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      if (cookies.some(c => /^sessionid_?ss?$/.test(c.name) && c.domain.includes('douyin.com'))) {
        loggedIn = true;
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (!loggedIn) {
      throw new Error(`等待登录超时（${LOGIN_WAIT_TIMEOUT} 秒），请重试`);
    }

    await page.waitForTimeout(5000); // 等 localStorage/页面写全
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    await context.storageState({ path: AUTH_FILE });
    const n = (JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).cookies || []).length;
    console.log(`\n✅ 登录态已保存: ${AUTH_FILE}（${n} 条 cookie）`);
  } finally {
    await browser.close();
  }
}

// ============ 单个输入下载 ============

async function downloadOne(browser, input, opts) {
  const modalId = await parseModal(input);
  console.log(`视频 ID: ${modalId}`);

  // 复用浏览器/context 减少实例开销；无登录态时也允许裸跑（部分公开视频无需登录）
  const context = await browser.newContext({
    storageState: opts.storageState, // undefined 则无登录态
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: UA,
  });
  await context.addInitScript(STEALTH_JS);
  const page = await context.newPage();

  try {
    const { play_url, title } = await getPlayInfo(page, modalId);
    console.log(`播放地址已获取，标题: ${title.slice(0, 40)}`);

    const dirName = `${sanitize(title)}_${modalId}`;
    const dir = path.join(opts.out, dirName);
    const outPath = path.join(dir, `${modalId}.mp4`);

    const size = await downloadFile(play_url, outPath);
    const meta = { title, modal_id: modalId, share_url: input, play_url, size };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    console.log(`下载完成: ${outPath}（${(size / 1e6).toFixed(1)} MB）`);
  } finally {
    await page.close();
    await context.close();
  }
}

// ============ main ============

async function main() {
  const { login, headful, out, file, inputs } = parseArgs(args);

  if (login) {
    await doLogin();
    return;
  }

  let inputsAll = inputs.slice();
  if (file) {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    inputsAll = inputsAll.concat(lines);
  }

  if (inputsAll.length === 0) {
    console.log(
      '用法:\n' +
      '  node scripts/scrape-douyin.js login                     # 登录抖音并保存登录态\n' +
      '  node scripts/scrape-douyin.js "<分享文本|短链|链接>"      # 下载单个视频\n' +
      '  node scripts/scrape-douyin.js --file urls.txt           # 批量下载\n' +
      '  node scripts/scrape-douyin.js <链接> --out downloads --headful\n'
    );
    process.exit(1);
  }

  // 登录态存在则带上，减少风控；不存在则警告并裸跑
  let storageState;
  if (fs.existsSync(AUTH_FILE)) {
    storageState = AUTH_FILE;
    console.log(`使用登录态: ${AUTH_FILE}`);
  } else {
    console.warn(`未找到登录态 ${AUTH_FILE}，部分视频可能被风控。可先运行: node scripts/scrape-douyin.js login`);
  }

  const browser = await chromium.launch({
    headless: !headful,
    args: CHROME_ARGS,
  });

  try {
    for (const input of inputsAll) {
      try {
        await downloadOne(browser, input, { out, storageState });
      } catch (e) {
        console.error(`× [失败] ${String(input).slice(0, 50)} → ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`× ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parseModal, sanitize, getPlayInfo, downloadFile, AUTH_FILE };
