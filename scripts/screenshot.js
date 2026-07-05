'use strict';
/*
 * screenshot.js — 夜バッチ用スクリーンショット撮影
 *
 * game.html を実際のブラウザで起動し、決まった採掘手順を再生してキャンバスを撮影する。
 * 撮った画像は screenshots/ に連番で保存し、screenshots/index.json に記録する。
 * これがページの「成長アルバム」（昨日 vs 今日）の素材になる。
 *   - 乱数を固定し、毎回だいたい同じ構図になるようにして変化を見比べやすくする。
 *   - 直近の logs.json からフェーズ・タスク情報を読み、画像に添える。
 *   - 保存枚数の上限(MAX_KEEP)を超えたら古い画像を削除する。
 *
 * 実行：node scripts/screenshot.js   （playwright と chromium が必要）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = 'screenshots';
const INDEX = path.join(DIR, 'index.json');
const MAX_KEEP = 40;

function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }

function latestMeta() {
  const logs = readJson('logs.json', []);
  const l = Array.isArray(logs) && logs.length ? logs[logs.length - 1] : null;
  if (!l) return { phase: null, phase_title: '', task: '' };
  return { phase: l.phase_id || null, phase_title: l.phase_title || '', task: (l.task || '').slice(0, 80) };
}

async function main() {
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (e) { console.log('[screenshot] playwright 未導入のためスキップ:', e.message); return; }

  // カレントを配信する簡易HTTPサーバ（file:// のfetch制限を避ける）
  const server = http.createServer((q, s) => {
    let f = '.' + decodeURIComponent(q.url.split('?')[0]);
    if (f === './') f = './game.html';
    fs.readFile(f, (e, d) => {
      if (e) { s.writeHead(404); s.end(); return; }
      const ext = path.extname(f);
      s.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : 'application/octet-stream' });
      s.end(d);
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const launchOpts = {};
  if (process.env.PW_CHROMIUM_PATH) launchOpts.executablePath = process.env.PW_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 600 } });
    // 乱数を固定して毎回だいたい同じ構図に（変化を見比べやすく）
    await page.addInitScript(() => {
      let s = 987654321;
      Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    });
    await page.goto(`http://localhost:${port}/game.html`, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    // 決まった採掘手順を再生
    const seq = ['d', 'd', 'd', 's', 's', 'a', 'a', 'w', 'd', 'd', 's', 'd', 'd'];
    for (const k of seq) { await page.keyboard.press(k); await page.waitForTimeout(90); }
    await page.waitForTimeout(700);

    fs.mkdirSync(DIR, { recursive: true });
    let index = readJson(INDEX, []);
    if (!Array.isArray(index)) index = [];
    const n = (index.length ? (index[index.length - 1].n || 0) : 0) + 1;
    const file = String(n).padStart(4, '0') + '.png';

    const canvas = await page.$('#gameCanvas');
    if (canvas) await canvas.screenshot({ path: path.join(DIR, file) });
    else await page.screenshot({ path: path.join(DIR, file) });

    const meta = latestMeta();
    index.push({ n, file, date: nowJst(), phase: meta.phase, phase_title: meta.phase_title, task: meta.task });
    while (index.length > MAX_KEEP) {
      const old = index.shift();
      try { fs.unlinkSync(path.join(DIR, old.file)); } catch (e) {}
    }
    fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n', 'utf8');
    console.log('[screenshot] 保存:', file, '/ フェーズ', meta.phase);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(e => { console.error('[screenshot] 失敗:', e && e.message ? e.message : e); process.exit(0); });
