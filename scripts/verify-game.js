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

function verifyGameHtml(html) {
  const errors = [];
  const code = extractScript(html);
  if (!code || code.length < 50) return { ok: false, errors: ['<script> が見つからない/短すぎる'] };

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
  try {
    vm.runInContext(code, context, { timeout: 5000, filename: 'game.html' });
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
  // 採掘→移動→戦闘までを一通り叩く（dで掘り進め、合間に上下移動）
  const seq = 'dddsdwddsaddwdsddddsddddwdd'.split('');
  if (!fireKeys(seq)) return { ok: false, errors };
  if (!tick(40)) return { ok: false, errors };          // 戦闘フェーズの生態系/勇者AIを回す

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
