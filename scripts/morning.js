'use strict';
/*
 * morning.js — 朝礼（コード改善フェーズ）v3 [C案: 対称型]
 *   lunch.js と同じ「セクション選定→生成→QA→game.html更新」を独立して実行する。
 *   morning_directive.json は廃止。feature_registry.json で lunch.js と連携する。
 *   user_intent.json を読み込み、オーナーの意図をプロンプトに反映する。
 *   外部npm不使用。Node標準の https と fs のみ。
 */
const fs = require('fs');
const https = require('https');
const { verifyGameHtml } = require('./verify-game.js');

const LAST_GOOD = 'game.last-good.html';
const MODEL = 'gemini-3.1-flash-lite';
const API_KEY = process.env.GEMINI_API_KEY || '';
const MAX_RETRY = 2;
const CYCLE_TYPE = 'morning';

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
`;

const IMPL_FREEDOM = `
【自由に創意工夫してよい領域（層2：大胆に拡張・改善することを推奨）】
- ビジュアル表現・グラフィック・色彩・ライティング・アニメーション・パーティクル
- UIレイアウト・情報の見せ方・HUD・ミニマップ・ステータス表示
- 魔物の種類・名前・能力値・成長曲線・捕食関係のデザイン
- 勇者の戦略・AI・侵攻パターン・職業/編成
- 演出・エフェクト・画面効果・カメラワーク
- 操作方法（ドラッグ・ホイール・Shift連動など）
`;

const SECTION_DEFS = {
  CONFIG:     '定数・Canvas初期化・グリッドサイズ(COLS/ROWS)・TILE計算・HUD高さ・mouseX/Y変数。',
  STATE:      'gameオブジェクト定義。monsters/heroes/phase/round/digsLeft/map/grid/message。新状態変数はここ。',
  ECOSYSTEM:  'mutate()・createMonster()・遺伝子継承・updateGrid()・resize()。魔物生成と生態系の核。',
  INIT_INPUT: 'init()（ラウンド初期化）とonDig()（クリック掘削ハンドラ）。掘削制限・魔物自動生成・勇者出現。',
  UPDATE:     'update(dt)。毎フレームの魔物移動・捕食・繁殖・勇者AI侵攻・攻撃・勝敗判定。',
  RENDER:     'render()。地形・魔物・勇者・HUD・エフェクト・マウスオーバーの全Canvas描画。ビジュアル品質に直結。'
};
const ALL_SECTIONS = Object.keys(SECTION_DEFS);

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
  if (!API_KEY) throw new Error('GEMINI_API_KEY が未設定です。');
  const waits = [5, 10, 20, 40, 80];
  for (let attempt = 0; attempt <= 5; attempt++) {
    const res = await postGemini(prompt, generationConfig);
    let json;
    try { json = JSON.parse(res.text); } catch (e) { throw new Error(`応答がJSONではありません: ${truncate(res.text, 300)}`); }
    const t = json && json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    if (t) return t;
    const code = (json && json.error && json.error.code) || res.status;
    if ((code === 503 || code === 429) && attempt < 5) {
      console.log(`[${MODEL}] ${code} → ${waits[attempt]}秒後にリトライ (${attempt + 1}/5)`);
      await sleep(waits[attempt] * 1000);
      continue;
    }
    throw new Error(`APIエラー(code=${code}): ${truncate(res.text, 400)}`);
  }
  throw new Error('リトライ上限。応答を取得できませんでした。');
}

// ============================================================
// ユーティリティ
// ============================================================
function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function readFileSafe(p, fb) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return fb; } }
function readJsonSafe(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }
function nowStamp() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
}
function extractJson(text) {
  let s = String(text == null ? '' : text).trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  const fb = s.indexOf('{'), lb = s.lastIndexOf('}');
  if (fb !== -1 && lb > fb) { try { return JSON.parse(s.slice(fb, lb + 1)); } catch (e) {} }
  return null;
}

// ============================================================
// セクション操作
// ============================================================
function extractSection(html, name) {
  const startTag = `// ===SECTION:${name}===`;
  const endTag = `// ===END:${name}===`;
  const s = html.indexOf(startTag);
  const e = html.indexOf(endTag);
  if (s === -1 || e === -1 || e < s) return null;
  return html.slice(s + startTag.length, e).trim();
}

function replaceSection(html, name, newContent) {
  const startTag = `// ===SECTION:${name}===`;
  const endTag = `// ===END:${name}===`;
  const s = html.indexOf(startTag);
  const e = html.indexOf(endTag);
  if (s === -1 || e === -1 || e < s) return null;
  return html.slice(0, s + startTag.length) + '\n' + newContent + '\n' + html.slice(e);
}

function hasSectionMarkers(html) {
  return ALL_SECTIONS.every(name =>
    html.includes(`// ===SECTION:${name}===`) && html.includes(`// ===END:${name}===`)
  );
}

// ============================================================
// 静的検証
// ============================================================
function scanBalance(code) {
  const depth = { '{': 0, '(': 0, '[': 0 };
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
    if (depth[c] !== undefined) depth[c]++;
    else if (close[c]) {
      depth[close[c]]--;
      if (depth[close[c]] < 0) return { ok: false, reason: `'${c}' が余分` };
    }
  }
  if (depth['{'] || depth['('] || depth['[']) return { ok: false, reason: `括弧不一致 {:${depth['{']} (:${depth['(']} [:${depth['[']}` };
  if (inStr) return { ok: false, reason: '文字列が閉じていない' };
  if (blockC) return { ok: false, reason: 'ブロックコメントが閉じていない' };
  return { ok: true };
}

function verifySectionCode(code) {
  const blocking = [];
  if (!code || code.length < 30) blocking.push('コードが短すぎる');
  if (code.includes('// ===SECTION:') || code.includes('// ===END:')) blocking.push('マーカーが混入している');
  if (/<\/?(?:html|body|script|head)/i.test(code)) blocking.push('HTMLタグが混入している');
  const bal = scanBalance(code);
  if (!bal.ok) blocking.push('構文エラー: ' + bal.reason);
  return { ok: blocking.length === 0, blocking };
}

function verifyFullHtml(html) {
  const blocking = [];
  if (!/<\/html>\s*$/i.test(html.trim())) blocking.push('</html> で終わっていない');
  if (html.length < 800) blocking.push('コードが短すぎる');
  if (!html.includes('<canvas')) blocking.push('<canvas> が欠落');
  if (!/function\s+init\b/.test(html)) blocking.push('init() が見当たらない');
  if (!html.includes('requestAnimationFrame')) blocking.push('requestAnimationFrame がない');
  const gi = html.search(/(?:let|const|var)\s+game\s*=/);
  if (gi === -1) {
    blocking.push('game オブジェクトが消失');
  } else {
    const around = html.slice(gi, gi + 800);
    if (!around.includes('monsters')) blocking.push('game.monsters が消失');
    if (!around.includes('heroes')) blocking.push('game.heroes が消失');
    if (!around.includes('phase')) blocking.push('game.phase が消失');
  }
  const missingMarkers = ALL_SECTIONS.filter(name =>
    !html.includes(`// ===SECTION:${name}===`) || !html.includes(`// ===END:${name}===`)
  );
  if (missingMarkers.length > 0) blocking.push(`セクションマーカーが消失: ${missingMarkers.join(', ')}`);
  return { ok: blocking.length === 0, blocking };
}

function isPass(s) { return String(s == null ? '' : s).trim().toUpperCase() === 'PASS'; }

// ============================================================
// セクション選定（feature_registry と user_intent を考慮）
// ============================================================
async function selectSection(gameHtml, registry, userIntent, logs) {
  const recentSections = Array.isArray(registry.recent_sections) ? registry.recent_sections.slice(-3) : [];
  const implementedFeatures = Array.isArray(registry.implemented_features) ? registry.implemented_features : [];
  const failedApproaches = Array.isArray(registry.failed_approaches) ? registry.failed_approaches : [];

  const logsText = logs.length
    ? logs.slice(-5).map(l => `- [${l.timestamp}] ${l.cycle_type} 対象:${l.target_section || '?'} ${l.result}`).join('\n')
    : '（ログなし）';

  const sectionDefsText = ALL_SECTIONS
    .map(k => `  ${k}${recentSections.includes(k) ? '【直近改善済み・今回は避けること】' : ''}: ${SECTION_DEFS[k]}`)
    .join('\n');

  const prompt = `
あなたはゲーム開発の意思決定エージェントです。
今サイクルで改善する「セクション1つ」と「具体的タスク」を決定してください。

${GAME_SOUL}
${IMPL_FREEDOM}

【オーナーの開発意図（最優先で反映すること）】
${userIntent || '（未設定）'}

【現在のgame.html】
${truncate(gameHtml, 4000)}

【改善可能なセクション一覧】
${sectionDefsText}

【直近3件で改善したセクション（必ず避けること）】
${recentSections.length ? recentSections.join(', ') : '（なし）'}

【蓄積済み実装済み機能（繰り返し禁止）】
${implementedFeatures.length ? implementedFeatures.slice(-12).map(f => '- ' + f).join('\n') : '（なし）'}

【過去の失敗アプローチ（繰り返し禁止）】
${failedApproaches.length ? failedApproaches.slice(-8).map(f => '- ' + f).join('\n') : '（なし）'}

【直近ログ】
${logsText}

次を厳密にJSONだけで出力してください（前置き・マークダウン禁止）:
{
  "target_section": "直近3件以外のセクション名（CONFIG/STATE/ECOSYSTEM/INIT_INPUT/UPDATE/RENDERのいずれか）",
  "specific_task": "このセクションで実装すべき改善内容。関数名・変数名・アルゴリズムまで具体的に。",
  "reason": "選定理由を1文で。オーナーの意図にどう応えるかを明示すること。"
}`;

  let json = extractJson(await callGemini(prompt, { temperature: 0.5, maxOutputTokens: 1024 }));

  if (!json || !json.target_section || !SECTION_DEFS[json.target_section] || recentSections.includes(json.target_section)) {
    const available = ALL_SECTIONS.filter(s => !recentSections.includes(s));
    const fallback = available[0] || 'RENDER';
    json = {
      target_section: fallback,
      specific_task: 'ビジュアル品質を向上させる。魔物と地形の描画をより個性的にする。',
      reason: 'フォールバック：未改善セクションを選定。'
    };
  }
  return json;
}

// ============================================================
// 生成→スプライス→QA（1サイクル分）
// ============================================================
async function generateAndReview(targetSection, specificTask, gameHtml, registry, userIntent, rejectReason) {
  const currentSectionCode = extractSection(gameHtml, targetSection) || '（未取得）';
  const sectionDesc = SECTION_DEFS[targetSection] || targetSection;
  const mustPreserve = (Array.isArray(registry.implemented_features)
    ? registry.implemented_features.filter(f => f.startsWith(`[${targetSection}]`))
    : []);

  const programmerPrompt = `
あなたは高度なプログラマーAIです。
指定されたセクションのJavaScriptコードのみを出力します。

${GAME_SOUL}
${IMPL_FREEDOM}

【オーナーの開発意図（最優先で反映すること）】
${userIntent || '（未設定）'}

【改善対象セクション】${targetSection}（${sectionDesc}）

【今回のタスク（必ず実装すること）】
${specificTask}

【現在のセクションコード（これを改善する）】
${currentSectionCode}

【このセクションで消してはならない機能】
${mustPreserve.length ? mustPreserve.map(x => '- ' + x).join('\n') : '- 既存の全機能（ゲームの魂7項目を壊さない範囲で改善）'}

${rejectReason ? `【前回の却下理由（必ず修正すること）】\n${rejectReason}\n` : ''}

【絶対に守ること】
- 出力は ${targetSection} セクションのJavaScriptコードのみ。
- HTMLタグ（<!DOCTYPE, <html, <body, <script 等）を一切含めない。
- // ===SECTION:=== や // ===END:=== などのマーカーを含めない。
- コードフェンス（\`\`\`）や解説文を含めない。JavaScriptコードを直接出力する。
- 現在より明らかに品質が向上していること。変化のないコードは失敗とみなす。
- ゲームの魂（7項目）を壊さない範囲で大胆に改善すること。`;

  const raw = await callGemini(programmerPrompt, { temperature: 0.75, maxOutputTokens: 8192 });
  let sectionCode = raw.replace(/```javascript\s*/gi, '').replace(/```js\s*/gi, '').replace(/```\s*/g, '').trim();

  const secCheck = verifySectionCode(sectionCode);
  if (!secCheck.ok) return { pass: false, html: gameHtml, reason: '[セクション検証NG]\n' + secCheck.blocking.join('\n') };

  const newHtml = replaceSection(gameHtml, targetSection, sectionCode);
  if (!newHtml) return { pass: false, html: gameHtml, reason: `[スプライス失敗] ${targetSection} のマーカーが見つかりません。` };

  if (sectionCode.trim() === currentSectionCode.trim()) {
    return { pass: false, html: gameHtml, reason: '[変更なし] より大胆な改善を加えてください。' };
  }

  const fullCheck = verifyFullHtml(newHtml);
  if (!fullCheck.ok) return { pass: false, html: gameHtml, reason: '[全文検証NG]\n' + fullCheck.blocking.join('\n') };

  // 実行ゲート：実際に起動して落ちないかを検証（横断的な不整合をここで弾く）
  const runCheck = verifyGameHtml(newHtml);
  if (!runCheck.ok) return { pass: false, html: gameHtml, reason: '[実行ゲートNG] 起動/実行時にエラー:\n' + runCheck.errors.join('\n') };

  const qaPrompt = `
あなたは品質・QAエージェントです。game.html の ${targetSection} セクションを書き換えた「新しいコード」を審査します。
（ファイル全体の構造・括弧の対応・セクションマーカーの保全は、別途プログラムが静的検証で確認済みです。あなたはこのセクションの内容のみを判定してください。全文を渡されているわけではありません。）

${GAME_SOUL}

【改善対象セクション】${targetSection}（${sectionDesc}）
【今回のタスク】${specificTask}

【新しい ${targetSection} セクションのコード（これがコードの全文。途中省略や切り詰めはされていない）】
${sectionCode}

判定基準:
(A) タスクが実際にコードとして実装されているか。
(B) このセクションが担う既存の役割・機能を壊していないか。
(C) 明らかな構文エラーや、未定義の変数・関数への依存がないか。
(D) 前のコードの単なる使い回しではなく、実際の改善になっているか。

注意: コードの末尾が「}」などで自然に終わっていれば、それは完成形です。「途切れている」と誤判定しないこと。
全て問題なければ「PASS」の4文字のみ出力してください。問題があれば原因を1〜3行で書いてください。`;

  const qa = await callGemini(qaPrompt, { temperature: 0.1, maxOutputTokens: 1024 });
  if (!isPass(qa)) return { pass: false, html: gameHtml, reason: '[QA却下] ' + truncate(qa, 500) };

  return { pass: true, html: newHtml, sectionCode, reason: 'PASS' };
}

// ============================================================
// メイン
// ============================================================
async function main() {
  let gameHtml = readFileSafe('game.html', '');
  const registry = readJsonSafe('feature_registry.json', { recent_sections: [], implemented_features: [], failed_approaches: [] });
  const logs = readJsonSafe('logs.json', []);
  const intentData = readJsonSafe('user_intent.json', {});
  const userIntent = String(intentData.intent || '');

  if (!Array.isArray(logs)) throw new Error('logs.json が配列ではありません。');

  // 自己修復：現在の game.html が壊れていたら、最後に動いた版へ巻き戻してから開始する
  const startCheck = verifyGameHtml(gameHtml);
  if (!startCheck.ok) {
    const lastGood = readFileSafe(LAST_GOOD, '');
    if (lastGood && verifyGameHtml(lastGood).ok) {
      console.log(`[${CYCLE_TYPE}] game.html が壊れています（${truncate(startCheck.errors.join(' / '), 120)}）→ ${LAST_GOOD} へ巻き戻します。`);
      fs.writeFileSync('game.html', lastGood, 'utf8');
      gameHtml = lastGood;
    } else {
      console.error(`[${CYCLE_TYPE}] game.html が壊れており、巻き戻し先もありません。中止します。`);
      process.exit(1);
    }
  }

  if (!hasSectionMarkers(gameHtml)) {
    console.error(`[${CYCLE_TYPE}] game.html にセクションマーカーがありません。`);
    process.exit(1);
  }

  console.log(`[${CYCLE_TYPE}] 開始。user_intent: ${truncate(userIntent, 80)}`);

  // セクション選定
  const selection = await selectSection(gameHtml, registry, userIntent, logs);
  const targetSection = selection.target_section;
  const specificTask = selection.specific_task;
  console.log(`[${CYCLE_TYPE}] 選定 → ${targetSection}: ${truncate(specificTask, 150)}`);

  // 生成→QA ループ
  const cycleNumber = logs.filter(l => l.cycle_type === CYCLE_TYPE).length + 1;
  let result = null;
  let lastReason = '';
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    console.log(`\n[${CYCLE_TYPE}] 試行 ${attempt + 1}/${MAX_RETRY + 1} ...`);
    result = await generateAndReview(targetSection, specificTask, gameHtml, registry, userIntent, lastReason);
    if (result.pass) break;
    lastReason = result.reason;
    console.log(`[${CYCLE_TYPE}] 却下: ` + truncate(lastReason, 200));
  }

  const timestamp = nowStamp();
  const implementedFeatures = Array.isArray(registry.implemented_features) ? [...registry.implemented_features] : [];
  const failedApproaches = Array.isArray(registry.failed_approaches) ? [...registry.failed_approaches] : [];
  const recentSections = Array.isArray(registry.recent_sections) ? [...registry.recent_sections] : [];

  if (result && result.pass) {
    fs.writeFileSync('game.html', result.html, 'utf8');
    fs.writeFileSync(LAST_GOOD, result.html, 'utf8');   // 動作確認済みをチェックポイント保存

    const newFeature = `[${targetSection}] ${truncate(specificTask, 80)}`;
    if (!implementedFeatures.some(f => f.startsWith(`[${targetSection}]`) && f.includes(truncate(specificTask, 30)))) {
      implementedFeatures.push(newFeature);
    }
    const newRecent = [...recentSections, targetSection].slice(-4);
    fs.writeFileSync('feature_registry.json', JSON.stringify(
      Object.assign({}, registry, { implemented_features: implementedFeatures.slice(-30), recent_sections: newRecent }),
      null, 2
    ) + '\n', 'utf8');

    logs.push({
      timestamp, cycle_type: CYCLE_TYPE, cycle_number: cycleNumber, result: 'success',
      target_section: targetSection, task: truncate(specificTask, 200),
      qa_note: 'PASS（AI-QA＋静的検証）', retry_count: 0
    });
    fs.writeFileSync('logs.json', JSON.stringify(logs, null, 2) + '\n', 'utf8');
    console.log(`\n[${CYCLE_TYPE}] ✅ ${targetSection} セクションを更新しました（cycle#${cycleNumber}）。`);
  } else {
    const failNote = `[${targetSection}] ${truncate(lastReason, 60)}`;
    if (!failedApproaches.some(f => f.startsWith(`[${targetSection}]`))) failedApproaches.push(failNote);
    const newRecent = [...recentSections, targetSection].slice(-4);
    fs.writeFileSync('feature_registry.json', JSON.stringify(
      Object.assign({}, registry, { failed_approaches: failedApproaches.slice(-20), recent_sections: newRecent }),
      null, 2
    ) + '\n', 'utf8');

    logs.push({
      timestamp, cycle_type: CYCLE_TYPE, cycle_number: cycleNumber, result: 'failure',
      target_section: targetSection, task: truncate(specificTask, 200),
      qa_note: truncate(lastReason, 400), retry_count: MAX_RETRY
    });
    fs.writeFileSync('logs.json', JSON.stringify(logs, null, 2) + '\n', 'utf8');
    console.log(`\n[${CYCLE_TYPE}] ❌ 全試行不合格。game.html は変更しません（cycle#${cycleNumber}）。`);
  }

  // 台本係：今回の会議を会話台本に翻訳（非クリティカル。失敗してもゲームは進む）
  try {
    const { generateTranscript } = require('./narrator.js');
    const transcript = await generateTranscript(logs[logs.length - 1], userIntent);
    fs.writeFileSync('transcript.json', JSON.stringify(transcript, null, 2) + '\n', 'utf8');
    console.log(`[${CYCLE_TYPE}] 台本を書き出しました（turns:${transcript.turns.length}）`);
  } catch (e) {
    console.log(`[${CYCLE_TYPE}] 台本生成スキップ:`, e && e.message ? e.message : e);
  }
}

main().catch(err => {
  console.error(`[${CYCLE_TYPE}] 致命的エラー:`, err && err.message ? err.message : err);
  process.exit(1);
});
