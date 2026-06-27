'use strict';
/*
 * morning.js — 朝礼（分析・評価・方針決定フェーズ）
 *   game.html は絶対に変更しない。morning_directive.json のみを生成する。
 *   外部npm不使用。Node標準の https と fs のみ。
 */
const fs = require('fs');
const https = require('https');

// ============================================================
// 固定設定（モデル変更禁止）
// ============================================================
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
　 ブラウザのウィンドウ全体に自動フィットする前提で、ピクセルの細かさや色合いを
　 自律的にデザイン・改善してください。TILE は描画時にウィンドウから逆算されます。
`;

// ============================================================
// Gemini API 共通呼び出し（503/429 指数バックオフ最大5回）
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
function today() { return new Date().toISOString().slice(0, 10); }

// AIのテキストから最初のJSONオブジェクト/配列を取り出す（マークダウン混入に耐える）
function extractJson(text) {
  let s = String(text == null ? '' : text).trim();
  s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  const fb = s.indexOf('{'), lb = s.lastIndexOf('}');
  if (fb !== -1 && lb !== -1 && lb > fb) {
    try { return JSON.parse(s.slice(fb, lb + 1)); } catch (e) { /* fallthrough */ }
  }
  return null;
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const gameHtml = readFileSafe('game.html', '');
  const logs = readJsonSafe('logs.json', []);
  const prevDirective = readJsonSafe('morning_directive.json', {});

  const logsText = logs.length
    ? logs.slice(-8).map(l => `- [${l.timestamp}] ${l.cycle_type}#${l.cycle_number} ${l.result}: ${l.changes || ''} / QA:${l.qa_note || ''}`).join('\n')
    : '（ログなし。初回サイクル）';
  const prevText = JSON.stringify(prevDirective || {}, null, 2);
  const nextCycle = (Number(prevDirective && prevDirective.cycle) || 0) + 1;

  // ---- エージェント① 司令塔 ----
  const commanderPrompt = `
あなたはプロジェクトの最高司令塔です。コードは一切書きません。
責務は「ゲームの魂（層1）を死守しながら、開発をPSPクオリティへ引き上げる方針を1つに絞ること」。

${GAME_SOUL}
${IMPL_FREEDOM}

【現在の game.html 全文】
${gameHtml}

【直近の開発ログ（最新最大8件）】
${logsText}

【前回の morning_directive.json】
${prevText}

上記を踏まえ、本日の司令塔ノートを出してください。必ず守ること:
(A) 前回サイクルの成否を整理する（失敗・QA却下・未解決が残っていれば、本日の最優先は迷わず「その修復」）。
(B) 7つの魂のうち壊れかけ／不足している点がないかを点検する。
(C) 本日チーム全員が最優先で取り組むテーマを欲張らず "ただ1つ" に絞る。
出力は日本語のプレーンテキストで、3〜6行。JSONや見出し記号は不要。`;
  const commanderNote = (await callGemini(commanderPrompt)).trim();
  console.log('--- commander_note ---\n' + commanderNote);

  // ---- エージェント② 評価 ----
  const evalPrompt = `
あなたは評価エージェントです。現在の game.html を読み、7つの魂それぞれの実装度を採点します。

${GAME_SOUL}

【現在の game.html 全文】
${gameHtml}

次を厳密にJSONだけで出力してください（前置き・マークダウン・コードフェンス一切禁止、キーと文字列は二重引用符）:
{
  "soul_scores": [魂1, 魂2, 魂3, 魂4, 魂5, 魂6, 魂7],   // 各0〜10の整数。7要素固定。
  "implemented_features": ["現在実装済みの機能を具体的に列挙（機能棚卸し）"],
  "weakest_point": "最も弱い／未実装の魂を1〜2行で特定",
  "quality_score": 0   // 全体の完成度を0〜100の整数で
}`;
  let ev = extractJson(await callGemini(evalPrompt, { temperature: 0.2, maxOutputTokens: 4096 }));
  if (!ev || !Array.isArray(ev.soul_scores)) {
    ev = { soul_scores: [0, 0, 0, 0, 0, 0, 0], implemented_features: [], weakest_point: '評価JSONの解析に失敗', quality_score: 0 };
  }
  // soul_scores を必ず7要素・整数に正規化
  const scores = [];
  for (let i = 0; i < 7; i++) {
    const n = Number(ev.soul_scores[i]);
    scores.push(Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 0);
  }
  ev.soul_scores = scores;
  ev.implemented_features = Array.isArray(ev.implemented_features) ? ev.implemented_features : [];
  ev.quality_score = Number.isFinite(Number(ev.quality_score)) ? Math.round(Number(ev.quality_score)) : 0;
  console.log('--- evaluation ---\n' + JSON.stringify(ev, null, 2));

  // ---- エージェント③ 企画 ----
  const plannerPrompt = `
あなたは企画エージェントです。ランチ（実装フェーズ）で実装すべき仕様を具体的に提案します。

${GAME_SOUL}
${IMPL_FREEDOM}

【司令塔ノート】
${commanderNote}

【評価結果】
- soul_scores: ${JSON.stringify(ev.soul_scores)}
- weakest_point: ${ev.weakest_point}
- implemented_features: ${JSON.stringify(ev.implemented_features)}

次を厳密にJSONだけで出力してください（前置き・マークダウン・コードフェンス一切禁止）:
{
  "planner_spec": "ランチで実装すべき仕様を、実装者が迷わない具体度で。優先順位と理由を含める（複数行可）。",
  "must_preserve": ["既存機能リストを参照し、絶対に消してはならない機能を具体的に列挙"],
  "priority": "ランチで最優先に実装すべきこと（1行）"
}`;
  let pl = extractJson(await callGemini(plannerPrompt, { temperature: 0.5, maxOutputTokens: 4096 }));
  if (!pl) pl = {};
  const plannerSpec = String(pl.planner_spec || commanderNote || '現状の7つの魂を全て動作させることを最優先に実装せよ。');
  const mustPreserve = Array.isArray(pl.must_preserve) && pl.must_preserve.length
    ? pl.must_preserve
    : (ev.implemented_features.length ? ev.implemented_features : [
        '魔王によるクリック掘削（魂1）',
        '掘削回数のラウンド制限（魂2）',
        '掘った土からの魔物自動生成（魂3）',
        '勇者の自律侵攻AI（魂5・魂6）',
        '魔物全滅で敗北／勇者全滅で次ラウンド（魂7）'
      ]);
  const priority = String(pl.priority || ev.weakest_point || '7つの魂が全て動作する基礎実装の確立');

  // ---- morning_directive.json を生成（game.html は変更しない） ----
  const directive = {
    date: today(),
    cycle: nextCycle,
    commander_note: commanderNote,
    evaluation: {
      soul_scores: ev.soul_scores,
      weakest_point: String(ev.weakest_point || ''),
      quality_score: ev.quality_score
    },
    implemented_features: ev.implemented_features,
    must_preserve: mustPreserve,
    planner_spec: plannerSpec,
    priority: priority
  };
  fs.writeFileSync('morning_directive.json', JSON.stringify(directive, null, 2) + '\n', 'utf8');
  console.log(`\n[morning] cycle#${nextCycle} の morning_directive.json を生成しました（game.html は不変）。`);
}

main().catch(err => {
  console.error('[morning] 致命的エラー:', err && err.message ? err.message : err);
  process.exit(1);
});
