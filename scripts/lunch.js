'use strict';
/*
 * lunch.js — ランチ（外科的セクション改善フェーズ）v2
 *   [変更点] game.html を全文書き換えではなく、1セクションのみを外科的に改善する。
 *   - AIが生成するのは対象セクションのJSコードのみ（数十〜百行）。
 *   - 他のセクションは一切変更しないため退行リスクがほぼゼロ。
 *   - 差分チェックにより「何も変わっていない」ケースを失敗として検出する。
 *   - 失敗時は feature_registry.json に failed_approaches として記録する。
 *   外部npm不使用。Node標準の https と fs のみ。
 */
const fs = require('fs');
const https = require('https');

const MODEL = 'gemini-3.1-flash-lite';
const API_KEY = process.env.GEMINI_API_KEY || '';
const MAX_RETRY = 2;

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

// セクション定義（morning.js と同じ内容を保つこと）
const SECTION_DEFS = {
  CONFIG:     '定数・Canvas初期化・グリッドサイズ(COLS/ROWS)・TILE計算・HUD高さ・mouseX/Y変数。',
  STATE:      'gameオブジェクト定義。monsters/heroes/phase/round/digsLeft/map/grid/message。新状態変数はここ。',
  ECOSYSTEM:  'mutate()・createMonster()・遺伝子継承・updateGrid()・resize()。魔物生成と生態系の核。',
  INIT_INPUT: 'init()（ラウンド初期化）とonDig()（クリック掘削ハンドラ）。掘削制限・魔物自動生成・勇者出現。',
  UPDATE:     'update(dt)。毎フレームの魔物移動・捕食・繁殖・勇者AI侵攻・攻撃・勝敗判定。',
  RENDER:     'render()。地形・魔物・勇者・HUD・エフェクト・マウスオーバーの全Canvas描画。ビジュアル品質に直結。'
};

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
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
  return Object.keys(SECTION_DEFS).every(name =>
    html.includes(`// ===SECTION:${name}===`) && html.includes(`// ===END:${name}===`)
  );
}

// ============================================================
// 括弧・文字列の対応チェック（GAS版移植）
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
      const o = close[c];
      depth[o]--;
      if (depth[o] < 0) return { ok: false, reason: `'${c}' が余分（閉じ括弧過多）` };
    }
  }
  if (depth['{'] || depth['('] || depth['[']) {
    return { ok: false, reason: `括弧の対応が不一致 {:${depth['{']} (:${depth['(']} [:${depth['[']}` };
  }
  if (inStr) return { ok: false, reason: '文字列リテラルが閉じていない' };
  if (blockC) return { ok: false, reason: 'ブロックコメントが閉じていない' };
  return { ok: true };
}

// ============================================================
// セクション生成物の静的検証
// ============================================================
function verifySectionCode(code) {
  const blocking = [];
  if (!code || code.length < 30) blocking.push('コードが短すぎる（生成失敗の可能性）');
  if (code.includes('// ===SECTION:') || code.includes('// ===END:')) {
    blocking.push('セクションマーカーが混入している（内容のみを出力すること）');
  }
  if (/<\/?(?:html|body|script|head|doctype)/i.test(code)) {
    blocking.push('HTMLタグが混入している（JavaScriptコードのみを出力すること）');
  }
  const bal = scanBalance(code);
  if (!bal.ok) blocking.push('構文エラー: ' + bal.reason);
  return { ok: blocking.length === 0, blocking };
}

// ============================================================
// スプライス後の全文静的検証
// ============================================================
function verifyFullHtml(html) {
  const blocking = [];
  if (!/<\/html>\s*$/i.test(html.trim())) blocking.push('</html> で終わっていない');
  if (html.length < 800) blocking.push('コードが短すぎる');
  if (!html.includes('<canvas')) blocking.push('<canvas> が欠落');
  if (!/function\s+init\b/.test(html)) blocking.push('init() が見当たらない');
  if (!html.includes('requestAnimationFrame')) blocking.push('requestAnimationFrame がない');
  const gi = html.search(/(?:let|const|var)\s+game\s*=/);
  if (gi === -1) {
    blocking.push('game オブジェクトの定義が消失');
  } else {
    const around = html.slice(gi, gi + 800);
    if (!around.includes('monsters')) blocking.push('game.monsters が消失');
    if (!around.includes('heroes')) blocking.push('game.heroes が消失');
    if (!around.includes('phase')) blocking.push('game.phase が消失');
  }
  // セクションマーカーの存在確認（AIが誤って全文書き換えした場合の検出）
  const missingMarkers = Object.keys(SECTION_DEFS).filter(name =>
    !html.includes(`// ===SECTION:${name}===`) || !html.includes(`// ===END:${name}===`)
  );
  if (missingMarkers.length > 0) blocking.push(`セクションマーカーが消失: ${missingMarkers.join(', ')}`);
  return { ok: blocking.length === 0, blocking };
}

function isPass(s) { return String(s == null ? '' : s).trim().toUpperCase() === 'PASS'; }

// ============================================================
// 1サイクル分：セクション生成 → スプライス → QA
// ============================================================
async function generateAndReview(directive, currentHtml, rejectReason) {
  const targetSection = directive.target_section;
  const specificTask = directive.specific_task || '';
  const plannerSpec = directive.planner_spec || specificTask;
  const mustPreserveInSection = Array.isArray(directive.must_preserve_in_section)
    ? directive.must_preserve_in_section : [];
  const currentSectionCode = extractSection(currentHtml, targetSection)
    || directive.current_section_code || '（未取得）';
  const sectionDesc = SECTION_DEFS[targetSection] || targetSection;

  // ---- プログラマーエージェント（セクション単体を生成） ----
  const programmerPrompt = `
あなたは高度なプログラマーAIです。
指定されたセクションのJavaScriptコードのみを出力します。

${GAME_SOUL}
${IMPL_FREEDOM}

【改善対象セクション】${targetSection}
【セクションの役割】${sectionDesc}

【今回のタスク（必ず実装すること）】
${specificTask}

【詳細仕様】
${plannerSpec}

【現在のセクションコード（これを改善する）】
${currentSectionCode}

【このセクション内で消してはならない機能・関数】
${mustPreserveInSection.length ? mustPreserveInSection.map(x => '- ' + x).join('\n') : '- 既存の全機能（ゲームの魂7項目を壊さない範囲で改善）'}

${rejectReason ? `【前回の却下理由（必ず修正すること）】\n${rejectReason}\n` : ''}

【絶対に守ること】
- 出力は ${targetSection} セクションのJavaScriptコードのみ。
- <!DOCTYPE, <html, <body, <script, </script>, </html> などのHTMLタグを一切含めない。
- // ===SECTION:=== や // ===END:=== などのマーカーを含めない。
- コードフェンス（\`\`\`）や解説文を含めない。JavaScriptコードを直接出力する。
- ゲームの魂（7項目）を壊さない範囲で、大胆かつ具体的に改善すること。
- 現在より明らかに品質が向上していること。同じコードの出力は失敗とみなす。`;

  const raw = await callGemini(programmerPrompt, { temperature: 0.75, maxOutputTokens: 8192 });

  // コードフェンス除去
  let sectionCode = raw
    .replace(/```javascript\s*/gi, '')
    .replace(/```js\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // セクション単体の静的検証
  const secCheck = verifySectionCode(sectionCode);
  if (!secCheck.ok) {
    return { pass: false, html: currentHtml, reason: '[セクション検証NG]\n' + secCheck.blocking.join('\n') };
  }

  // スプライス：対象セクションのみ置換
  const newHtml = replaceSection(currentHtml, targetSection, sectionCode);
  if (!newHtml) {
    return {
      pass: false, html: currentHtml,
      reason: `[スプライス失敗] ${targetSection} セクションのマーカーが game.html に見つかりません。`
    };
  }

  // 差分チェック（変更がなければ失敗）
  if (sectionCode.trim() === currentSectionCode.trim()) {
    return {
      pass: false, html: currentHtml,
      reason: '[変更なし] セクションのコードが変更されませんでした。より大胆な改善を加えてください。'
    };
  }

  // スプライス後の全文静的検証
  const fullCheck = verifyFullHtml(newHtml);
  if (!fullCheck.ok) {
    return { pass: false, html: currentHtml, reason: '[全文検証NG]\n' + fullCheck.blocking.join('\n') };
  }

  // QAエージェント（全文を検証）
  const qaPrompt = `
あなたは品質・QAエージェントです。最後の砦として、魂と構造を守る門番です。

${GAME_SOUL}

【更新後の game.html 全文】
${truncate(newHtml, 7000)}

【今回改善したセクション】${targetSection}
【今回のタスク】${specificTask}

次の観点で確認してください:
(A) 7つの魂がすべて実装されているか（形骸化も含め）。
(B) <canvas>・init()・requestAnimationFrame が存在するか。
(C) game.monsters・game.heroes・game.phase が存在するか。
(D) JavaScriptに明らかな構文エラーがないか。
(E) 今回のタスク「${truncate(specificTask, 100)}」が実際に実装されているか（同じコードの使い回しでないか）。

すべて問題なければ「PASS」の4文字のみ出力してください（前後に何も付けない）。
問題があれば「PASS」とは書かず、観点(A)〜(E)で何が問題かを1〜3行で書いてください。`;

  const qa = await callGemini(qaPrompt, { temperature: 0.1, maxOutputTokens: 1024 });
  if (!isPass(qa)) {
    return { pass: false, html: currentHtml, reason: '[QA却下] ' + truncate(qa, 500) };
  }

  return { pass: true, html: newHtml, sectionCode, reason: 'PASS' };
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const currentHtml = readFileSafe('game.html', '');
  const directive = readJsonSafe('morning_directive.json', {});
  const registry = readJsonSafe('feature_registry.json', { implemented_features: [], failed_approaches: [] });
  const logs = readJsonSafe('logs.json', []);
  if (!Array.isArray(logs)) throw new Error('logs.json が配列ではありません。');

  // セクションマーカーチェック
  if (!hasSectionMarkers(currentHtml)) {
    console.error('[lunch] game.html にセクションマーカーがありません。朝礼が先行している必要があります。');
    console.error('[lunch] 必要なマーカー: // ===SECTION:CONFIG=== 〜 // ===SECTION:RENDER===');
    process.exit(1);
  }

  // morning_directive からターゲットセクションを取得
  const targetSection = directive.target_section;
  if (!targetSection || !SECTION_DEFS[targetSection]) {
    console.error(`[lunch] morning_directive.json に有効な target_section がありません（値: ${targetSection}）。朝礼を先に実行してください。`);
    process.exit(1);
  }

  const cycleNumber = logs.filter(l => l.cycle_type === 'lunch').length + 1;
  console.log(`[lunch] cycle#${cycleNumber} → 対象セクション: ${targetSection}`);
  console.log(`[lunch] タスク: ${truncate(directive.specific_task, 200)}`);

  // ---- プログラマー → QA（最大 MAX_RETRY 回） ----
  let result = null;
  let lastReason = '';
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    console.log(`\n[lunch] 試行 ${attempt + 1}/${MAX_RETRY + 1} ...`);
    result = await generateAndReview(directive, currentHtml, lastReason);
    if (result.pass) break;
    lastReason = result.reason;
    console.log('[lunch] 却下: ' + truncate(lastReason, 300));
  }

  const timestamp = nowStamp();
  const implementedFeatures = Array.isArray(registry.implemented_features) ? registry.implemented_features : [];
  const failedApproaches = Array.isArray(registry.failed_approaches) ? registry.failed_approaches : [];

  if (result && result.pass) {
    fs.writeFileSync('game.html', result.html, 'utf8');

    // feature_registry.json の実装済み機能を追加（重複なし・最大30件）
    const newFeature = `[${targetSection}] ${truncate(directive.specific_task, 80)}`;
    if (!implementedFeatures.some(f => f.startsWith(`[${targetSection}]`) &&
        f.includes(truncate(directive.specific_task, 40)))) {
      implementedFeatures.push(newFeature);
    }
    const updatedRegistry = Object.assign({}, registry, {
      implemented_features: implementedFeatures.slice(-30)
    });
    fs.writeFileSync('feature_registry.json', JSON.stringify(updatedRegistry, null, 2) + '\n', 'utf8');

    logs.push({
      timestamp,
      cycle_type: 'lunch',
      cycle_number: cycleNumber,
      result: 'success',
      target_section: targetSection,
      task: truncate(directive.specific_task, 200),
      changes: truncate(directive.planner_spec || '', 300),
      qa_note: 'PASS（AI-QA＋静的検証＋差分確認）',
      retry_count: 0
    });
    fs.writeFileSync('logs.json', JSON.stringify(logs, null, 2) + '\n', 'utf8');
    console.log(`\n[lunch] ✅ QA合格。${targetSection} セクションを更新しました（cycle#${cycleNumber}）。`);
  } else {
    // 失敗時：failed_approaches に記録（重複なし・最大20件）
    const failNote = `[${targetSection}] ${truncate(lastReason, 80)}`;
    if (!failedApproaches.some(f => f.includes(truncate(lastReason, 40)))) {
      failedApproaches.push(failNote);
    }
    const updatedRegistry = Object.assign({}, registry, {
      failed_approaches: failedApproaches.slice(-20)
    });
    fs.writeFileSync('feature_registry.json', JSON.stringify(updatedRegistry, null, 2) + '\n', 'utf8');

    logs.push({
      timestamp,
      cycle_type: 'lunch',
      cycle_number: cycleNumber,
      result: 'failure',
      target_section: targetSection,
      task: truncate(directive.specific_task, 200),
      changes: 'なし（QA不合格のため game.html 非変更）',
      qa_note: truncate(lastReason, 400),
      retry_count: MAX_RETRY
    });
    fs.writeFileSync('logs.json', JSON.stringify(logs, null, 2) + '\n', 'utf8');
    console.log(`\n[lunch] ❌ 全試行不合格。game.html は変更しません（cycle#${cycleNumber}）。`);
  }
}

main().catch(err => {
  console.error('[lunch] 致命的エラー:', err && err.message ? err.message : err);
  process.exit(1);
});
