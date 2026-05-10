const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, '..', '.auth', 'bilibili.json');
const QR_TIMEOUT = 120000; // 2分钟等扫码

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

  // 跳转 B 站登录页（二维码登录）
  console.log('正在打开 B站 登录页...');
  await page.goto('https://passport.bilibili.com/login', { waitUntil: 'networkidle', timeout: 30000 });

  console.log('\n请使用 B站 APP 扫描屏幕上的二维码登录。');
  console.log('等待扫码...');

  // 等待登录成功（检测 URL 跳转或 cookie 中出现 bili_jct / SESSDATA）
  try {
    await page.waitForURL('https://www.bilibili.com/**', { timeout: QR_TIMEOUT });
    console.log('检测到登录成功！');
  } catch {
    // 没跳转的话，手动检测 cookie
    await page.waitForTimeout(5000);
    const cookies = await context.cookies();
    const hasSession = cookies.some(c => c.name === 'SESSDATA' && c.value && c.value !== '');
    if (!hasSession) {
      console.log('扫码超时或未检测到登录，继续等待...');
      try {
        await page.waitForURL('https://www.bilibili.com/**', { timeout: QR_TIMEOUT });
        console.log('检测到登录成功！');
      } catch {
        console.log('登录超时，请重试。');
        await browser.close();
        process.exit(1);
      }
    }
  }

  // 等待一下确保页面加载完
  await page.waitForTimeout(3000);

  // 保存 storage 状态
  const authDir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  await context.storageState({ path: AUTH_FILE });

  const cookies = await context.cookies();
  const sessionCookie = cookies.find(c => c.name === 'SESSDATA');
  const hasVip = cookies.some(c => c.name === 'buvid3');
  console.log(`\n✅ 登录状态已保存到: .auth/bilibili.json`);
  console.log(`   SESSDATA: ${sessionCookie ? '✓ 已获取' : '✗ 未获取'}`);
  console.log(`   建议将此文件加入 .gitignore 避免泄漏`);

  await browser.close();
})();
