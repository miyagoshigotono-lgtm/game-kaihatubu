'use strict';
/*
 * narrator.js — 台本係（4人目のエージェント）
 *
 * 役割：開発会議の「事実」を、固定の進行に沿った かわいい日本語の会話台本(transcript)に翻訳する。
 *   - 内部の3人（部長/主任/プログラマー）はコードで仕事をするだけでよく、
 *     日本語の会話は台本係がまとめて生成する。
 *   - 事実だけに基づいて脚色する（嘘を足さない）。
 *   - 非クリティカル：生成に失敗してもゲーム開発は止めない。失敗時は定型台本にフォールバックする。
 *
 * 出力：transcript.json
 *   { date, cycle_type, agenda, success, turns: [ { role, name, line } ... ] }
 *
 * 外部npm不使用。Node標準の https / fs のみ。
 */
const https = require('https');

const MODEL = 'gemini-3.1-flash-lite';
const API_KEY = process.env.GEMINI_API_KEY || '';

const SECTION_JP = {
  CONFIG: '設定', STATE: '状態', ECOSYSTEM: '生態系',
  INIT_INPUT: '操作・初期化', UPDATE: '更新処理', RENDER: '描画'
};

// 会議の登場人物（ページ側のキャラと一致させること）
const CAST = {
  bucho:      { name: '部長' },
  shunin:     { name: '主任' },
  programmer: { name: 'プログラマー' }
};

// ============================================================
// ユーティリティ
// ============================================================
function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nowStampJst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function extractJson(text) {
  let s = String(text == null ? '' : text).trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  const fb = s.indexOf('{'), lb = s.lastIndexOf('}');
  if (fb !== -1 && lb !== -1 && lb > fb) {
    try { return JSON.parse(s.slice(fb, lb + 1)); } catch (e) { /* fallthrough */ }
  }
  return null;
}

// 会議の事実をまとめる
function buildFacts(cycle) {
  cycle = cycle || {};
  const section = SECTION_JP[cycle.target_section] || cycle.target_section || 'ゲーム';
  const success = cycle.result === 'success';
  const task = truncate(cycle.task || cycle.priority || '', 80) || 'こまかな調整';
  return {
    date: cycle.timestamp || nowStampJst(),
    cycle_type: cycle.cycle_type || 'meeting',
    section: section,
    agenda: `「${section}」まわりの改善`,
    task: task,
    success: success,
    qa: truncate(cycle.qa_note || '', 120)
  };
}

// 定型台本（API失敗時のフォールバック。固定の進行）
function fallbackTurns(facts) {
  const ok = facts.success;
  return [
    { role: 'bucho',      line: `では、会議を始めよう。今日のテーマは「${facts.section}」だ。` },
    { role: 'shunin',     line: ok ? '前回からの状態、確認しました。問題ありません。' : '前回は少し不安定でしたね…今日は慎重に。' },
    { role: 'programmer', line: `${truncate(facts.task, 40)}…を実装してみました。` },
    { role: 'shunin',     line: ok ? 'はい、ちゃんと動いています。合格です！' : 'うーん、もう一息。ここを直しましょう。' },
    { role: 'bucho',      line: ok ? 'よし、今日も一歩前進だ。みんなご苦労。' : '次こそ仕上げよう。頼んだぞ。' }
  ];
}

// ============================================================
// Gemini API（503/429 指数バックオフ。最大4回）
// ============================================================
function postGemini(prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.85, maxOutputTokens: 1024 }
  });
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = ''; res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function callGemini(prompt) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY 未設定');
  const waits = [4, 8, 16, 32];
  for (let attempt = 0; attempt <= 4; attempt++) {
    const res = await postGemini(prompt);
    let json;
    try { json = JSON.parse(res.text); } catch (e) { throw new Error('応答がJSONでない'); }
    const t = json && json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    if (t) return t;
    const code = (json && json.error && json.error.code) || res.status;
    if ((code === 503 || code === 429) && attempt < 4) { await sleep(waits[attempt] * 1000); continue; }
    throw new Error(`APIエラー(code=${code})`);
  }
  throw new Error('リトライ上限');
}

function narratorPrompt(facts, userIntent) {
  return `
あなたはAI開発会社の「台本係」です。
開発チームの“実際の会議の出来事”を、かわいくて自然な日本語の会話劇に書き起こします。
登場人物は3人：部長(bucho／リーダー)、主任(shunin／レビュー担当)、プログラマー(programmer／実装担当)。

【今日の事実 — これだけに基づいて脚色すること。事実にないことを足さない】
- 種別：${facts.cycle_type === 'morning' ? '朝礼' : facts.cycle_type === 'lunch' ? 'ランチ' : '開発会議'}
- 改善した部分：${facts.agenda}
- 実装タスク：${facts.task}
- 結果：${facts.success ? '成功（動作確認OK）' : '不成功（修正が必要）'}
${facts.qa ? `- QAコメント：${facts.qa}` : ''}
${userIntent ? `\n【社長の要望（会話に意識を反映してよい）】\n${truncate(userIntent, 120)}` : ''}

【会議の進行 — この順番・役割を必ず守る】
1. 部長が会議を開始し、今日のテーマを述べる
2. 主任が状態についてレビュー視点で一言
3. プログラマーが実装内容を報告
4. 主任が結果を判定（成功なら合格、失敗なら直す点）
5. 部長が締める（成功なら労い、失敗なら次への鼓舞）
※ 途中に短い相槌・掛け合いを入れてよい。発言は合計5〜8個。

【出力 — 厳密にJSONのみ。前置き・マークダウン・コードフェンス禁止】
{
  "turns": [
    { "role": "bucho", "line": "セリフ（40字程度まで・自然でかわいい口調）" }
  ]
}
roleは bucho / shunin / programmer のいずれか。`;
}

// ============================================================
// メイン関数：会議の事実 → 台本
// ============================================================
async function generateTranscript(cycle, userIntent) {
  const facts = buildFacts(cycle);
  let turns = null;
  try {
    const raw = await callGemini(narratorPrompt(facts, userIntent || ''));
    const json = extractJson(raw);
    if (json && Array.isArray(json.turns)) {
      turns = json.turns
        .filter(t => t && CAST[t.role] && t.line)
        .map(t => ({ role: t.role, name: CAST[t.role].name, line: truncate(String(t.line), 120) }));
    }
  } catch (e) {
    console.log('[narrator] 生成失敗 → 定型台本にフォールバック:', e.message);
  }
  if (!turns || turns.length < 3) {
    turns = fallbackTurns(facts).map(t => ({ role: t.role, name: CAST[t.role].name, line: t.line }));
  }
  return {
    date: facts.date,
    cycle_type: facts.cycle_type,
    agenda: facts.agenda,
    success: facts.success,
    turns: turns
  };
}

module.exports = { generateTranscript, buildFacts, fallbackTurns };

// 単体実行：node scripts/narrator.js → logs.json の最新エントリから transcript.json を生成
if (require.main === module) {
  const fs = require('fs');
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync('logs.json', 'utf8')); } catch (e) { logs = []; }
  const latest = Array.isArray(logs) && logs.length ? logs[logs.length - 1] : null;
  let intent = '';
  try { intent = JSON.parse(fs.readFileSync('user_intent.json', 'utf8')).intent || ''; } catch (e) {}
  if (!latest) {
    console.log('[narrator] logs.json が空です。transcript.json は生成しません。');
    process.exit(0);
  }
  generateTranscript(latest, intent).then(t => {
    fs.writeFileSync('transcript.json', JSON.stringify(t, null, 2) + '\n', 'utf8');
    console.log(`[narrator] transcript.json を書き出しました（turns:${t.turns.length}）`);
  }).catch(e => { console.error('[narrator] 失敗:', e.message); process.exit(1); });
}
