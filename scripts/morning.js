'use strict';
/*
 * morning.js — 朝礼（分析・セクション選定・方針決定フェーズ）v2
 *   [変更点] セクション単位の外科的改善方式。
 *   feature_registry.json を読み、直近3件で触ったセクションを避けて選定する。
 *   game.html は一切変更しない。morning_directive.json + feature_registry.json のみ更新。
 *   外部npm不使用。Node標準の https と fs のみ。
 */
const fs = require('fs');
const https = require('https');

const MODEL = 'gemini-3.1-flash-lite';
const API_KEY = process.env.GEMINI_API_KEY || '';

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

// セクション定義（lunch.js と同じ内容を保つこと）
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
function today() { return new Date().toISOString().slice(0, 10); }

function extractJson(text) {
  let s = String(text == null ? '' : text).trim();
  s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  const fb = s.indexOf('{'), lb = s.lastIndexOf('}');
  if (fb !== -1 && lb !== -1 && lb > fb) {
    try { return JSON.parse(s.slice(fb, lb + 1)); } catch (e) { /* fallthrough */ }
  }
  return null;
}

// game.html からセクション内容を抽出
function extractSection(html, name) {
  const startTag = `// ===SECTION:${name}===`;
  const endTag = `// ===END:${name}===`;
  const s = html.indexOf(startTag);
  const e = html.indexOf(endTag);
  if (s === -1 || e === -1 || e < s) return null;
  return html.slice(s + startTag.length, e).trim();
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const gameHtml = readFileSafe('game.html', '');
  const logs = readJsonSafe('logs.json', []);
  const prevDirective = readJsonSafe('morning_directive.json', {});
  const registry = readJsonSafe('feature_registry.json', {
    recent_sections: [], implemented_features: [], failed_approaches: [], current_cycle: 0
  });

  const recentSections = Array.isArray(registry.recent_sections) ? registry.recent_sections.slice(-3) : [];
  const implementedFeatures = Array.isArray(registry.implemented_features) ? registry.implemented_features : [];
  const failedApproaches = Array.isArray(registry.failed_approaches) ? registry.failed_approaches : [];
  const nextCycle = (Number(prevDirective.cycle) || 0) + 1;

  const logsText = logs.length
    ? logs.slice(-6).map(l =>
        `- [${l.timestamp}] ${l.cycle_type}#${l.cycle_number} ${l.result} 対象:${l.target_section || '全体'} / ${l.qa_note || ''}`
      ).join('\n')
    : '（ログなし。初回サイクル）';

  const sectionDefsText = ALL_SECTIONS
    .map(k => `  ${k}${recentSections.includes(k) ? '【直近改善済み・今回は避けること】' : ''}: ${SECTION_DEFS[k]}`)
    .join('\n');

  // ---- エージェント① 司令塔（セクション選定） ----
  const commanderPrompt = `
あなたはゲーム開発プロジェクトの司令塔です。コードは一切書きません。
【任務】今サイクルで改善する「セクション1つ」と「具体的タスク」を決定する。

${GAME_SOUL}
${IMPL_FREEDOM}

【現在の game.html 全文】
${truncate(gameHtml, 5000)}

【改善可能なセクション一覧】
${sectionDefsText}

【直近3件で改善したセクション（必ず避けること）】
${recentSections.length ? recentSections.join(', ') : '（なし）'}

【蓄積済み実装済み機能（繰り返し禁止）】
${implementedFeatures.length ? implementedFeatures.slice(-15).map(f => '- ' + f).join('\n') : '（なし）'}

【過去の失敗アプローチ（繰り返し禁止）】
${failedApproaches.length ? failedApproaches.slice(-10).map(f => '- ' + f).join('\n') : '（なし）'}

【直近の開発ログ】
${logsText}

重要な制約:
- target_section は直近3件（${recentSections.join(', ') || 'なし'}）以外から必ず選ぶ。
- specific_task は「既に実装済みの機能」を繰り返してはならない。
- ゲームの見た目・ビジュアル・エフェクトが1990年代レベルから脱却していない場合、RENDERを優先せよ。

次を厳密にJSONだけで出力してください（前置き・マークダウン・コードフェンス禁止）:
{
  "target_section": "CONFIG/STATE/ECOSYSTEM/INIT_INPUT/UPDATE/RENDERのいずれか1つ",
  "specific_task": "このセクションで実装すべき改善内容。実装者が迷わない具体度（関数名・変数名・アルゴリズムまで）で書く。",
  "commander_note": "選定理由・全体の開発方針を2〜3文で述べる。"
}`;

  let cmdJson = extractJson(await callGemini(commanderPrompt, { temperature: 0.5, maxOutputTokens: 2048 }));

  // バリデーション：target_section が有効でなければフォールバック
  if (!cmdJson || !cmdJson.target_section || !SECTION_DEFS[cmdJson.target_section]) {
    const available = ALL_SECTIONS.filter(s => !recentSections.includes(s));
    cmdJson = {
      target_section: available[0] || 'RENDER',
      specific_task: 'ゲームのビジュアル品質を向上させる。魔物・地形・勇者の描画を現代的なグラフィックに改善する。',
      commander_note: 'フォールバック：直近未改善のセクションを選定した。'
    };
  }
  // target_section が直近3件に含まれる場合も上書き
  if (recentSections.includes(cmdJson.target_section)) {
    const available = ALL_SECTIONS.filter(s => !recentSections.includes(s));
    if (available.length > 0) {
      cmdJson.target_section = available[0];
      cmdJson.commander_note = `[強制ローテーション] ${cmdJson.commander_note}`;
    }
  }

  const targetSection = cmdJson.target_section;
  const specificTask = String(cmdJson.specific_task || '');
  const commanderNote = String(cmdJson.commander_note || '');
  console.log(`--- commander → target: ${targetSection} ---\n${truncate(specificTask, 300)}`);

  // 現在のセクション内容を取得（ランチへ渡す）
  const currentSectionCode = extractSection(gameHtml, targetSection) || '（セクションマーカーが見つかりません）';

  // ---- エージェント② 評価 ----
  const evalPrompt = `
あなたは評価エージェントです。game.html を読み、7つの魂の実装度と全体品質を採点します。

${GAME_SOUL}

【現在の game.html 全文】
${truncate(gameHtml, 4000)}

次を厳密にJSONだけで出力してください（前置き・マークダウン・コードフェンス禁止）:
{
  "soul_scores": [魂1〜7のスコア(0〜10の整数)。7要素固定],
  "quality_score": 0,
  "weakest_point": "最も弱い点を1行で",
  "section_quality": {
    "CONFIG": 0, "STATE": 0, "ECOSYSTEM": 0, "INIT_INPUT": 0, "UPDATE": 0, "RENDER": 0
  }
}`;
  let ev = extractJson(await callGemini(evalPrompt, { temperature: 0.2, maxOutputTokens: 2048 }));
  if (!ev || !Array.isArray(ev.soul_scores)) {
    ev = { soul_scores: [5, 5, 5, 5, 5, 5, 5], quality_score: 50, weakest_point: '評価取得失敗', section_quality: {} };
  }
  const scores = [];
  for (let i = 0; i < 7; i++) {
    const n = Number(ev.soul_scores[i]);
    scores.push(Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 5);
  }
  ev.soul_scores = scores;
  ev.quality_score = Number.isFinite(Number(ev.quality_score)) ? Math.round(Number(ev.quality_score)) : 50;
  ev.section_quality = (ev.section_quality && typeof ev.section_quality === 'object') ? ev.section_quality : {};
  console.log('--- evaluation ---\n' + JSON.stringify(ev, null, 2));

  // ---- エージェント③ 企画（セクション特化の仕様書） ----
  const plannerPrompt = `
あなたは企画エージェントです。ランチ（実装フェーズ）でプログラマーが迷わないよう、詳細な実装仕様書を作ります。

${GAME_SOUL}

【改善対象セクション】${targetSection}（${SECTION_DEFS[targetSection]}）

【司令塔の指示】
${specificTask}

【このセクションの現在のコード】
${truncate(currentSectionCode, 2000)}

【評価】quality_score: ${ev.quality_score} / weakest: ${ev.weakest_point}

次を厳密にJSONだけで出力してください:
{
  "planner_spec": "このセクションで実装すべき仕様を詳細に。追加・変更すべき関数名・変数名・アルゴリズムを具体的に記述。",
  "must_preserve_in_section": ["このセクション内で消してはならない既存の関数名・変数名・ロジックを列挙"],
  "expected_result": "実装後にゲームがどう変わるかを1文で"
}`;
  let pl = extractJson(await callGemini(plannerPrompt, { temperature: 0.4, maxOutputTokens: 2048 }));
  if (!pl) pl = {};
  const plannerSpec = String(pl.planner_spec || specificTask);
  const mustPreserveInSection = Array.isArray(pl.must_preserve_in_section) ? pl.must_preserve_in_section : [];
  const expectedResult = String(pl.expected_result || '品質向上');

  // ---- morning_directive.json 生成 ----
  const directive = {
    date: today(),
    cycle: nextCycle,
    target_section: targetSection,
    specific_task: specificTask,
    commander_note: commanderNote,
    evaluation: {
      soul_scores: ev.soul_scores,
      weakest_point: String(ev.weakest_point || ''),
      quality_score: ev.quality_score,
      section_quality: ev.section_quality
    },
    planner_spec: plannerSpec,
    must_preserve_in_section: mustPreserveInSection,
    expected_result: expectedResult,
    current_section_code: truncate(currentSectionCode, 3000)
  };
  fs.writeFileSync('morning_directive.json', JSON.stringify(directive, null, 2) + '\n', 'utf8');

  // ---- feature_registry.json 更新（recent_sections のみ更新） ----
  const newRecent = [...recentSections, targetSection].slice(-4);
  const updatedRegistry = Object.assign({}, registry, {
    recent_sections: newRecent,
    current_cycle: nextCycle
  });
  fs.writeFileSync('feature_registry.json', JSON.stringify(updatedRegistry, null, 2) + '\n', 'utf8');

  console.log(`\n[morning] cycle#${nextCycle} → target_section: ${targetSection}`);
  console.log(`[morning] task: ${truncate(specificTask, 200)}`);
}

main().catch(err => {
  console.error('[morning] 致命的エラー:', err && err.message ? err.message : err);
  process.exit(1);
});
