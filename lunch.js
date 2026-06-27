'use strict';
/*
 * lunch.js — ランチ（実装フェーズ）
 *   morning_directive.json に従い game.html を全文生成して上書きする。
 *   QA（AIの"PASS"完全一致）＋静的検証（verifyMergedCode移植）＋出力切れガードの三段で守る。
 *   外部npm不使用。Node標準の https と fs のみ。
 */
const fs = require('fs');
const https = require('https');

const MODEL = 'gemini-3.1-flash-lite';
const API_KEY = process.env.GEMINI_API_KEY || '';
const MAX_RETRY = 2; // QA却下時の再生成回数

const GAME_SOUL = `
【ゲームタイトル】破壊神のダンジョンメイカー
【ジャンル】魔王視点の地下迷宮育成 × 生態系シミュレーション

【死守すべきゲームの魂（層1：絶対に変更・削除・形骸化させてはならない核ルール）】
1. プレイヤーは「魔王」として地下迷宮（ダンジョン）を自らの手で掘り進める。
2. 掘削行動の回数には制限がある（ラウンド制で管理され、無限には掘れない）。
3. 掘って出た土から、魔物が自動的に生成される（プレイヤーが個別配置するのではない）。
4. 魔物たちは食物連鎖・捕食・進化を通じて、一つの生態系として自律的に育っていく。
5. 「勇者」がダンジョンへ自律的に侵攻してくる（プレイヤー操作ではなくAIで動く）。
6. プレイヤー（魔王）は勇者を直接攻撃できない。生態系・地形を介して間接的にしか干渉できない。
7. 魔物が全滅したら敗北。勇者を全滅させられたらクリアし、次のラウンドへ進む。

※ これら7項目はゲームの存在理由そのものです。どの提案・実装も、この魂を一つたりとも
　 壊さない・薄めない・例外を作らないことを最優先の制約とします。
`;

const IMPL_FREEDOM = `
【自由に創意工夫してよい領域（層2：むしろ大胆に拡張・改善することを推奨）】
- 操作方法（WASD / マウス / Shift連動 / ドラッグ / ホイール など、何でもよい）
- ビジュアル表現・グラフィック・色彩・ライティング・アニメーション
- UIレイアウト・情報の見せ方・HUD・ミニマップ・ステータス表示
- 魔物の種類・名前・能力値・成長曲線・捕食関係のデザイン
- 勇者の戦略・AI・侵攻パターン・職業/編成
- 演出・エフェクト・画面効果・サウンド表現・カメラワーク

※ 階層1の魂を一切壊さない範囲であれば、ここは自由に・マニアックに尖らせてよい領域です。
　 ブラウザのウィンドウ全体に自動フィットする前提で設計すること。
`;

// ============================================================
// Gemini API（503/429 指数バックオフ最大5回）
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function postGemini(prompt, generationConfig) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: generationConfig || { temperature: 0.6, maxOutputTokens: 8192 }
  });
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callGemini(prompt, generationConfig) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY が未設定です。GitHub Secrets を確認してください。');
  const waits = [5, 10, 20, 40, 80];
  for (let attempt = 0; attempt <= 5; attempt++) {
    const res = await postGemini(prompt, generationConfig);
    let json;
    try { json = JSON.parse(res.text); }
    catch (e) { throw new Error(`[${MODEL}] 応答がJSONではありません: ${truncate(res.text, 300)}`); }

    const t = json &&
      json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    if (t) return t;

    const code = (json && json.error && json.error.code) || res.status;
    if ((code === 503 || code === 429) && attempt < 5) {
      console.log(`[${MODEL}] ${code} 発生。${waits[attempt]}秒後にリトライ (${attempt + 1}/5)`);
      await sleep(waits[attempt] * 1000);
      continue;
    }
    throw new Error(`[${MODEL}] APIエラー(code=${code}): ${truncate(res.text, 400)}`);
  }
  throw new Error(`[${MODEL}] リトライ上限。応答を取得できませんでした。`);
}

// ============================================================
// ユーティリティ
// ============================================================
function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function readFileSafe(p, fallback) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return fallback; } }
function readJsonSafe(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }
function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// AI出力から <!DOCTYPE html> 〜 </html> を抜き出す（コードフェンス混入に耐える）
function extractHtml(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/```html/gi, '').replace(/```/g, '');
  const lower = s.toLowerCase();
  const start = lower.indexOf('<!doctype');
  const end = lower.lastIndexOf('</html>');
  if (start !== -1 && end !== -1 && end > start) return s.slice(start, end + '</html>'.length);
  return s.trim();
}

// ============================================================
// 静的検証（GASの verifyMergedCode を移植・全文版に適応）
//   blocking が1つでもあれば不合格。
// ============================================================
function verifyGameHtml(code, mustPreserve) {
  const blocking = [];

  // (A) 出力切れガード（64Kトークン天井対策）
  if (!/<\/html>\s*$/i.test(code.trim())) blocking.push('・</html> で終わっていない（出力が途中で切れた可能性）');
  if (code.length < 800) blocking.push('・コードが短すぎる（生成失敗の可能性）');

  // (B) 必須の骨格
  if (code.indexOf('<script>') === -1 || code.indexOf('</script>') === -1) blocking.push('・<script>〜</script> が欠落');
  if (code.indexOf('<canvas') === -1) blocking.push('・<canvas> が欠落');
  if (!/function\s+init\b/.test(code)) blocking.push('・init() が見当たらない（初期化が消えた）');
  if (code.indexOf('requestAnimationFrame') === -1) blocking.push('・requestAnimationFrame が無い（ゲームループが止まる）');

  // (C) 括弧・文字列の対応
  const bal = scanBalance(code);
  if (!bal.ok) blocking.push('・構文: ' + bal.reason);

  // (D) game オブジェクトの構造ガード（魂のデータ消失を防ぐ）
  const gi = code.search(/(?:let|const|var)\s+game\s*=/);
  if (gi === -1) {
    blocking.push('・game オブジェクトの定義が消失');
  } else {
    const around = code.slice(gi, gi + 800);
    if (around.indexOf('monsters') === -1) blocking.push('・game に monsters（魔物配列）が無い');
    if (around.indexOf('heroes') === -1) blocking.push('・game に heroes（勇者配列）が無い');
    if (around.indexOf('phase') === -1) blocking.push('・game に phase（進行状態）が無い');
  }

  // (E) must_preserve のキーワード残存チェック（消してはならない機能の見張り。警告→ここでは致命扱い）
  const missing = [];
  (Array.isArray(mustPreserve) ? mustPreserve : []).forEach(item => {
    const kw = pickKeyword(item);
    if (kw && code.indexOf(kw) === -1) missing.push(`${item}（手掛かり語:"${kw}"）`);
  });
  if (missing.length) blocking.push('・must_preserve の痕跡が見当たらない: ' + missing.join(' / '));

  return { ok: blocking.length === 0, blocking };
}

// must_preserve文字列から、コード内に残るべき英数字キーワードを1つ拾う
function pickKeyword(item) {
  const m = String(item).match(/[A-Za-z_][A-Za-z0-9_]{2,}/);
  return m ? m[0] : '';
}

// 括弧 {} () [] と文字列・コメントの対応をスキャン（GAS _scanBalance 移植）
function scanBalance(code) {
  const depth = { '{': 0, '(': 0, '[': 0 };
  const open = { '{': 1, '(': 1, '[': 1 };
  const close = { '}': '{', ')': '(', ']': '[' };
  let inStr = null, lineC = false, blockC = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i], n = code[i + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { lineC = true; i++; continue; }
    if (c === '/' && n === '*') { blockC = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (open[c]) depth[c]++;
    else if (close[c]) { const o = close[c]; depth[o]--; if (depth[o] < 0) return { ok: false, reason: `'${c}' が余分（閉じ括弧過多）` }; }
  }
  if (depth['{'] || depth['('] || depth['[']) return { ok: false, reason: `括弧の対応が不一致 {:${depth['{']} (:${depth['(']} [:${depth['[']}` };
  if (inStr) return { ok: false, reason: '文字列リテラルが閉じていない' };
  if (blockC) return { ok: false, reason: 'ブロックコメントが閉じていない' };
  return { ok: true };
}

// QAは "PASS" の完全一致のみ通す（前後の空白・改行のみ許容）
function isPass(s) { return String(s == null ? '' : s).trim().toUpperCase() === 'PASS'; }

// ============================================================
// 1サイクル分の生成→QA
// ============================================================
async function generateAndReview(designSpec, currentHtml, directive, rejectReason) {
  const mustPreserve = (directive && directive.must_preserve) || [];

  const programmerPrompt = `
あなたは高度なプログラマーAIです。指示書を忠実にコードへ翻訳し、game.html を【全文】出力します。

${GAME_SOUL}
${IMPL_FREEDOM}

【実装指示書（設計エージェント作）】
${designSpec}

【現在の game.html 全文】
${currentHtml}

【絶対に消してはならない機能（must_preserve）】
${(mustPreserve.length ? mustPreserve.map(x => '- ' + x).join('\n') : '- 7つの魂すべて')}
${rejectReason ? `\n【前回QAの却下理由（必ず修正すること）】\n${rejectReason}\n` : ''}

実装上の絶対ルール:
- 層1の7つの魂を壊す・無効化する・例外を作る変更は禁止。
- must_preserve の機能を全て残すこと。
- 差分JSONやセクションマーカー（##SECTION##等）は一切使わない。完成した game.html を全文出力する。
- <!DOCTYPE html> から </html> まで、ブラウザで直接開いて単体で動く完結したHTMLを出力する。
- <canvas>・init()・requestAnimationFrame を必ず含む。game オブジェクトには monsters / heroes / phase を必ず持たせる。
- キャンバスはブラウザのウィンドウ全体に自動フィットさせる（固定サイズのダイアログ前提にしない）。
- 出力は game.html の中身そのものだけ。前置き・解説・コードフェンス（\`\`\`）は一切付けない。`;

  const raw = await callGemini(programmerPrompt, { temperature: 0.7, maxOutputTokens: 32768 });
  const html = extractHtml(raw);

  // 静的検証（AIに渡す前に機械チェック。出力切れ・骨格欠落・魂消失を弾く）
  const staticCheck = verifyGameHtml(html, mustPreserve);
  if (!staticCheck.ok) {
    return { pass: false, html, reason: '[静的検証NG]\n' + staticCheck.blocking.join('\n') };
  }

  // QAエージェント（"PASS" 完全一致でのみ通す）
  const qaPrompt = `
あなたは品質・QAエージェントです。最後の砦として、魂と構造を守る門番です。

${GAME_SOUL}

【生成された game.html 全文】
${html}

次の観点で最終確認してください:
(A) 7つの魂が全て実装されているか（一つでも壊れ・形骸化があれば不合格）。
(B) <canvas>・init()・requestAnimationFrame が存在するか。
(C) JavaScriptに明らかな構文崩壊（閉じ括弧不足など）がないか。
(D) must_preserve の機能が全て含まれているか:
${(mustPreserve.length ? mustPreserve.map(x => '- ' + x).join('\n') : '- 7つの魂すべて')}

すべて問題なければ、半角4文字「PASS」だけを出力してください（前後に文字・記号・改行説明を一切付けない）。
問題があれば「PASS」とは絶対に書かず、どの観点(A/B/C/D)で何が問題かを1〜3行で出力してください。`;
  const qa = await callGemini(qaPrompt, { temperature: 0.1, maxOutputTokens: 1024 });
  if (!isPass(qa)) return { pass: false, html, reason: '[QA却下] ' + truncate(qa, 500) };

  return { pass: true, html, reason: 'PASS' };
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const currentHtml = readFileSafe('game.html', '');
  const directive = readJsonSafe('morning_directive.json', {});
  const logs = readJsonSafe('logs.json', []);
  if (!Array.isArray(logs)) throw new Error('logs.json が配列ではありません。');

  const logsText = logs.length
    ? logs.slice(-8).map(l => `- [${l.timestamp}] ${l.cycle_type}#${l.cycle_number} ${l.result}: ${l.changes || ''}`).join('\n')
    : '（ログなし）';
  const priority = (directive && directive.priority) || '7つの魂が全て動作する基礎実装の確立';
  const cycleNumber = (logs.filter(l => l.cycle_type === 'lunch').length) + 1;

  // ---- エージェント① 設計 ----
  const designPrompt = `
あなたは設計エージェントです。「何をどう変えるか」の詳細実装仕様書を作ります。コードは書きません。

${GAME_SOUL}
${IMPL_FREEDOM}

【朝礼の結論 morning_directive.json】
${JSON.stringify(directive, null, 2)}

【現在の game.html 全文】
${currentHtml}

【過去ログ（失敗パターン把握用・最大8件）】
${logsText}

次を必ず網羅した実装仕様書を、日本語プレーンテキストで出力してください:
1. 目的（このサイクルで何を達成するか／どの魂を深掘りするか）
2. 変更箇所（既存のどこを直すか）と新設箇所
3. 状態変数（monsters/heroes/round/digsLeft/phase 等）への具体的影響
4. 不変条件（must_preserve と 7つの魂を壊さないために守ること）
5. 完成基準（何が動けば成功とみなすか）
朝礼の priority「${priority}」を最優先にすること。`;
  const designSpec = (await callGemini(designPrompt, { temperature: 0.4, maxOutputTokens: 4096 })).trim();
  console.log('--- design_spec ---\n' + truncate(designSpec, 1200));

  // ---- ②プログラマー → ③QA（最大 MAX_RETRY 回まで再生成） ----
  let result = null;
  let lastReason = '';
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    console.log(`\n[lunch] 生成試行 ${attempt + 1}/${MAX_RETRY + 1} ...`);
    result = await generateAndReview(designSpec, currentHtml, directive, lastReason);
    if (result.pass) break;
    lastReason = result.reason;
    console.log('[lunch] 却下: ' + truncate(lastReason, 400));
  }

  const timestamp = nowStamp();
  if (result && result.pass) {
    fs.writeFileSync('game.html', result.html, 'utf8');
    logs.push({
      timestamp,
      cycle_type: 'lunch',
      cycle_number: cycleNumber,
      result: 'success',
      priority,
      changes: truncate(designSpec.replace(/\s+/g, ' '), 300),
      qa_note: 'PASS（AI-QA＋静的検証）',
      retry_count: 0
    });
    fs.writeFileSync('logs.json', JSON.stringify(logs, null, 2) + '\n', 'utf8');
    console.log(`\n[lunch] ✅ QA合格。game.html を上書きしました（cycle#${cycleNumber}）。`);
  } else {
    // 2回失敗 → game.html は変更せず、失敗ログのみ
    logs.push({
      timestamp,
      cycle_type: 'lunch',
      cycle_number: cycleNumber,
      result: 'failure',
      priority,
      changes: 'なし（QA不合格のため game.html 非変更）',
      qa_note: truncate(lastReason, 400),
      retry_count: MAX_RETRY
    });
    fs.writeFileSync('logs.json', JSON.stringify(logs, null, 2) + '\n', 'utf8');
    console.log(`\n[lunch] ❌ ${MAX_RETRY + 1}回とも不合格。game.html は変更しません（cycle#${cycleNumber}）。`);
  }
}

main().catch(err => {
  console.error('[lunch] 致命的エラー:', err && err.message ? err.message : err);
  process.exit(1);
});
