// ==UserScript==
// @name         抖音无水印视频下载
// @namespace    https://github.com/wang18678665352/claw
// @version      1.0.0
// @description  在抖音视频页右上角加「下载视频」按钮：拦截页面自己的 aweme detail 请求取无水印播放地址，GM_xmlhttpRequest 跨域下载。浏览器自带登录态，无需另外登录。
// @author       王成烨
// @match        https://www.douyin.com/*
// @match        https://*.douyin.com/*
// @match        https://v.douyin.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

/*
 * 原理与 scripts/scrape-douyin.js 一致，但改在用户已登录的页面里跑：
 *
 *  1. 视频页加载时，页面会请求 aweme/v1/web/aweme/detail 拿播放信息（已经带上签名+cookie）。
 *  2. 这里在 document-start 包装 page 的 fetch / XHR，把 detail 响应缓存下来 → 无水印 URL。
 *  3. 点「下载视频」→ 取出 url_list[0]，用 GM_xmlhttpRequest 转 blob 触发保存（绕过 CORS、
 *     可带 Referer，和页面的 CDN 直链一致）。
 *
 * 补点：detail 还没加载时点击，会先等它加载完；CDN 拒绝下载则把播放地址开到新标签让用户手动保存。
 */

(() => {
  'use strict';

  const DETAIL_PART = 'aweme/v1/web/aweme/detail';

  // ============ 状态与 URL 解析 ============

  const state = { id: '', detail: null };

  function getAwemeId() {
    const fromPath = location.pathname.match(/\/video\/(\d+)/);
    if (fromPath) return fromPath[1];
    return new URLSearchParams(location.search).get('modal_id') || '';
  }

  function extractPlayUrl(detail) {
    const video = detail.video || {};
    // 优先默认 play_addr，其次常见变体，再逐个 bit_rate
    const candidates = [
      video.play_addr,
      video.play_addr_h264,
      video.play_addr_265,
    ];
    for (const b of (video.bit_rate || [])) candidates.push(b.play_addr);
    for (const c of candidates) {
      const urls = (c || {}).url_list || [];
      if (urls.length) return urls[0];
    }
    return '';
  }

  function buildFilename(detail, id) {
    const desc = String(detail.desc || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 60);
    const title = desc || id;
    return `${title}.mp4`;
  }

  function tryCaptureDetail(data) {
    const d = data && data.aweme_detail;
    if (!d) return;
    // 只认当前页视频（避免放到别的视频的详情）
    if (!state.id || String(d.aweme_id) === state.id) state.detail = d;
  }

  // ============ 拦截页面自身的 detail 请求 ============

  function hookNetwork() {
    // fetch
    const origFetch = unsafeWindow.fetch;
    if (typeof origFetch === 'function') {
      unsafeWindow.fetch = function (...args) {
        return origFetch.apply(this, args).then(resp => {
          try {
            if (String(resp.url).includes(DETAIL_PART)) {
              resp.clone().json().then(tryCaptureDetail).catch(() => {});
            }
          } catch {}
          return resp;
        });
      };
    }

    // XHR（部分请求走 XHR）
    const origOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    const origSend = unsafeWindow.XMLHttpRequest.prototype.send;
    unsafeWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__dyUrl = String(url);
      return origOpen.call(this, method, url, ...rest);
    };
    unsafeWindow.XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          if ((this.__dyUrl || '').includes(DETAIL_PART)) {
            tryCaptureDetail(JSON.parse(this.responseText));
          }
        } catch {}
      });
      return origSend.apply(this, args);
    };
  }

  // ============ 下载 ============

  function saveBlob(blob, name) {
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  }

  function download(url, name) {
    // GM_xmlhttpRequest 是扩展上下文请求：跨域无 CORS 限制，且可带 Referer 命中和页面一致的 CDN 直链
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: 'blob',
      headers: { Referer: 'https://www.douyin.com/' },
      onload: r => {
        if (r.status === 200 && r.response) {
          saveBlob(r.response, name);
          toast(`已开始下载 ${name}`);
        } else {
          // CDN 拒绝（403/防盗链）→ 开到新标签，用户手动右键保存
          toast('CDN 拒绝下载，已在标签页打开视频，可右键另存为');
          window.open(url, '_blank');
        }
      },
      onerror: () => {
        toast('下载失败，已在标签页打开视频，可右键另存为');
        window.open(url, '_blank');
      },
    });
  }

  // ============ 点击逻辑 ============

  async function ensureDetail() {
    const id = getAwemeId();
    state.id = id;
    if (!id) return null;

    // detail 已缓存 → 直接用它
    if (state.detail && String(state.detail.aweme_id) === id) return state.detail;
    if (state.detail) state.detail = null; // URL 变了，清空旧缓存

    // 等页面加载期间拦截到（最长 10s）
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (state.detail && String(state.detail.aweme_id) === id) return state.detail;
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  }

  async function onDownloadClick() {
    let detail = await ensureDetail();
    // 兜底：拦截没成功就直接请求一次（登录态同源，cookie 自动带上）
    if (!detail) {
      try {
        const r = await fetch(`/aweme/v1/web/aweme/detail/?aweme_id=${state.id}`, {
          credentials: 'include',
        });
        const j = await r.json();
        if (j.aweme_detail) {
          detail = j.aweme_detail;
          tryCaptureDetail(j);
        }
      } catch {}
    }
    if (!detail) {
      toast('未获取到视频信息，等页面加载完再点');
      return;
    }
    const url = extractPlayUrl(detail);
    if (!url) {
      toast('未找到播放地址（接口改版？）');
      return;
    }
    download(url, buildFilename(detail, state.id));
  }

  // ============ 按钮 UI ============

  GM_addStyle(`
    #dy-dl-btn {
      position: fixed; top: 96px; right: 24px; z-index: 99999;
      background: rgba(254, 44, 85, 0.92); color: #fff;
      border: none; border-radius: 20px; padding: 10px 18px;
      font: 14px/1 "Microsoft YaHei", sans-serif; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25); transition: opacity .2s;
    }
    #dy-dl-btn:hover { opacity: .85; }
    #dy-dl-btn.is-hidden { display: none; }
    #dy-toast {
      position: fixed; left: 50%; top: 20%; transform: translateX(-50%);
      z-index: 99999; background: rgba(0,0,0,.75); color: #fff;
      padding: 8px 16px; border-radius: 6px; font: 13px/1.4 sans-serif;
      pointer-events: none; transition: opacity .3s; opacity: 0;
    }
  `);

  function toast(msg) {
    let el = document.getElementById('dy-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dy-toast';
      document.body && document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    clearTimeout(el.__t);
    el.__t = setTimeout(() => { el.style.opacity = '0'; }, 2600);
  }

  function updateVisibility() {
    const btn = document.getElementById('dy-dl-btn');
    if (!btn) return;
    const isVideoPage = !!getAwemeId();
    btn.classList.toggle('is-hidden', !isVideoPage);
  }

  function ensureButton() {
    if (document.getElementById('dy-dl-btn')) return;
    if (!document.body) {
      // body 未就绪时用轮询等待（@run-at document-start）
      setTimeout(ensureButton, 100);
      return;
    }
    const btn = document.createElement('button');
    btn.id = 'dy-dl-btn';
    btn.textContent = '下载视频';
    btn.className = 'is-hidden';
    btn.addEventListener('click', () => {
      onDownloadClick().catch(() => toast('下载出错了'));
    });
    document.body.appendChild(btn);
  }

  // ============ 启动 ============

  hookNetwork();
  ensureButton();

  // SPA：地址变化时刷新按钮显隐
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      updateVisibility();
    }
  }, 500);
})();
