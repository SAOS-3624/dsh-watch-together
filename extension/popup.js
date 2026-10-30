/**
 * popup.js — 点扩展图标时弹出来的小面板：现在通不通、在看第几秒。
 *
 * 直接问本地服务要"最近一次上报"，比问后台记忆更可信 ——
 * 后台的 service worker 可能刚被回收过，记的东西是空的，但服务那边的文件还在。
 */

/* global chrome */

const $ = (id) => document.getElementById(id);

function mmss(sec) {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function refresh() {
  let state = '未连上';
  let cls = 'bad';
  let posText = '—';
  let titleText = '—';
  let serverText = '连不上 127.0.0.1:9377';

  try {
    const r = await fetch('http://127.0.0.1:9377/api/position', { cache: 'no-store' });
    const j = await r.json();
    if (j && j.ok !== false && Number.isFinite(j.pos)) {
      state = '已连上';
      cls = 'ok';
      posText = `${mmss(j.pos)}${j.dur ? ` / ${mmss(j.dur)}` : ''}${j.paused ? '（暂停）' : ''}`;
      titleText = j.title || '—';
      serverText = `正常（${Math.round((j.ageMs ?? 0) / 1000)} 秒前刚收到）`;
    } else {
      // 服务在，但没有新位置：多半是当前标签页里没有 <video>
      state = '服务在，没有视频';
      cls = 'bad';
      serverText = '正常，但这个页面没有 <video>';
    }
  } catch {
    // 服务没起。再问一次后台，看它有没有留住更具体的原因
    try {
      const last = await chrome.runtime.sendMessage({ type: 'status' });
      if (last?.error) serverText = last.error;
    } catch { /* 后台也没醒就算了 */ }
  }

  $('state').textContent = state;
  $('state').className = `v big ${cls}`;
  $('pos').textContent = posText;
  $('title').textContent = titleText;
  $('server').textContent = serverText;
}

refresh();
setInterval(refresh, 1000);
