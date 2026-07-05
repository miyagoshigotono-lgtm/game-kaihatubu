'use strict';
/*
 * verify-game.js — 実行ゲート（run-gate）
 *
 * 目的：game.html を“実際に起動”して、JSが落ちないことを確かめる。
 *   セクション単位の編集では「TILE未定義」「playerX二重宣言」「onDig未定義」のような
 *   横断的な不整合が、静的チェック（括弧・マーカー）をすり抜けて起動時に落ちる。
 *   これを毎回、軽量サンドボックス（ブラウザ不使用・npm不使用）で捕まえる。
 *
 * やること：
 *   1. <script> を取り出し、Canvas/window/document を最小スタブして vm で実行
 *      → トップレベルの SyntaxError / ReferenceError（未定義参照・二重宣言）を捕捉
 *   2. requestAnimationFrame のループを数十フレーム回し、キー入力も流し込む
 *      → update/render/生態系/勇者AI など各経路の実行時エラーを捕捉
 *
 * 使い方：
 *   const { verifyGameHtml } = require('./verify-game.js');
 *   const r = verifyGameHtml(htmlString);  // { ok:boolean, errors:string[] }
 *   コマンド：node scripts/verify-game.js [path]   (既定 game.html)
 */
const fs = require('fs');
const vm = require('vm');

function extractScript(html) {
  const m = String(html).match(/<script>([\s\S]*?)<\/script>/i);
  return m ? m[1] : '';
}

// 何でも吸収するプロキシ（ctx描画系・canvas等のダミー）
function makeAny() {
  let any;
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return undefined;
      if (prop === 'then') return undefined;       // thenable扱いされないように
      if (prop === 'length') return 0;
      return any;
    },
    set() { return true; },
    apply() { return any; },
    construct() { return any; }
  };
  any = new Proxy(function () {}, handler);
  return any;
}

// 同名の関数宣言が複数ないか（後の定義が静かに前を上書きし、意味崩壊を起こす）
function findDuplicateFunctions(code) {
  const counts = {};
  const re = /(?:^|\n)\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) { counts[m[1]] = (counts[m[1]] || 0) + 1; }
  return Object.keys(counts).filter(k => counts[k] > 1);
}

function verifyGameHtml(html) {
  const errors = [];
  const code = extractScript(html);
  if (!code || code.length < 50) return { ok: false, errors: ['<script> が見つからない/短すぎる'] };

  // 静的：関数の二重定義を禁止（今回の生態系崩壊の主犯）
  const dups = findDuplicateFunctions(code);
  if (dups.length) return { ok: false, errors: ['関数が二重定義されています（後の定義が前を上書きし挙動が壊れます）: ' + dups.join(', ')] };

  const any = makeAny();
  const listeners = {};
  const rafQueue = [];
  function addL(type, cb) { if (typeof cb === 'function') (listeners[type] = listeners[type] || []).push(cb); }

  const windowStub = {
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    addEventListener: (t, cb) => addL(t, cb),
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    performance: { now: () => Date.now() },
    devicePixelContentBox: undefined
  };
  const documentStub = {
    getElementById: () => any,
    querySelector: () => any,
    querySelectorAll: () => [],
    createElement: () => any,
    addEventListener: (t, cb) => addL(t, cb),
    body: any, documentElement: any
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    performance: { now: () => Date.now() },
    console: { log() {}, warn() {}, error() {}, info() {} },
    // 標準ビルトイン
    Math, Date, JSON, RegExp, Error, Promise, Symbol,
    Array, Object, Number, String, Boolean, Map, Set, WeakMap, WeakSet,
    Float32Array, Float64Array, Int32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Infinity, NaN, undefined
  };
  sandbox.window.document = documentStub;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);

  // 1) スクリプトのトップレベル実行（ここで構文/未定義/二重宣言が落ちる）
  //    実行後に game 状態を検査できるよう、末尾で globalThis に露出させる。
  const probedCode = code + '\n;try{ globalThis.__gs = (typeof game !== "undefined") ? game : null; }catch(e){ globalThis.__gs = null; }';
  try {
    vm.runInContext(probedCode, context, { timeout: 5000, filename: 'game.html' });
  } catch (e) {
    return { ok: false, errors: ['起動時エラー: ' + (e && e.message ? e.message : String(e))] };
  }

  // 2) ループを回す＋キー入力を流す
  let ts = 16;
  function tick(frames) {
    for (let i = 0; i < frames; i++) {
      const cb = rafQueue.shift();
      if (!cb) break;
      try { cb(ts); } catch (e) { errors.push('ループ実行エラー: ' + (e && e.message ? e.message : String(e))); return false; }
      ts += 16;
    }
    return true;
  }
  function fireKeys(keys) {
    const ks = listeners['keydown'] || [];
    for (const k of keys) {
      for (const cb of ks) {
        try { cb({ key: k, code: k, preventDefault() {}, stopPropagation() {} }); }
        catch (e) { errors.push('入力処理エラー(' + k + '): ' + (e && e.message ? e.message : String(e))); return false; }
      }
      if (!tick(2)) return false;
      if (errors.length) return false;
    }
    return true;
  }

  if (!tick(5)) return { ok: false, errors };
  // 採掘→移動を叩いて魔物を湧かせる（この時点で生態系が動き出す）
  const seq = 'dddsdwddsaddwds'.split('');
  if (!fireKeys(seq)) return { ok: false, errors };

  // --- 行動ゲート：ゲームが「生きている」かを検査 ---
  const gs = sandbox.__gs;
  function coord(v) { return typeof v === 'number' && isFinite(v); }
  if (gs && gs.monsters && gs.monsters.length) {
    // NaN混入チェック（座標・エネルギーが壊れていないか）
    for (const m of gs.monsters) {
      if (!coord(m.x) || !coord(m.y)) { errors.push('魔物の座標がNaN/不正（生態系が壊れています）'); break; }
    }
    if (gs.player && (!coord(gs.player.x) || !coord(gs.player.y))) errors.push('プレイヤー座標がNaN/不正');

    // 生態系が動いているか：魔物の配置を記録して150フレーム回し、変化があるか
    const before = gs.monsters.map(m => m.id + ':' + m.x + ',' + m.y).join('|');
    const cntBefore = gs.monsters.length;
    if (!tick(150)) return { ok: false, errors };
    const after = (sandbox.__gs.monsters || []).map(m => m.id + ':' + m.x + ',' + m.y).join('|');
    const cntAfter = (sandbox.__gs.monsters || []).length;
    if (cntBefore > 0 && before === after && cntBefore === cntAfter) {
      errors.push('生態系が凍結（魔物が一切動かず・増減もしない）。ecosystemが呼ばれていないか、魔物にenergy/cooldownが無い可能性。');
    }
  } else {
    // 魔物が湧かない＝採掘で魔物生成が機能していない
    errors.push('採掘しても魔物が1体も生まれない（spawnMonster/採掘連携が壊れています）。');
  }

  if (!tick(40)) return { ok: false, errors };

  return { ok: errors.length === 0, errors };
}

module.exports = { verifyGameHtml, extractScript };

// コマンド実行
if (require.main === module) {
  const path = process.argv[2] || 'game.html';
  let html;
  try { html = fs.readFileSync(path, 'utf8'); } catch (e) { console.error('読み込み失敗:', path); process.exit(2); }
  const r = verifyGameHtml(html);
  if (r.ok) { console.log('✅ 実行ゲート合格:', path); process.exit(0); }
  console.error('❌ 実行ゲート不合格:', path);
  r.errors.forEach(e => console.error('  - ' + e));
  process.exit(1);
}
