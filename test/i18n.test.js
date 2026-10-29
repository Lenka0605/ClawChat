import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr, setLang, getLang } from '../lib/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(ROOT, 'public', 'locales');
const SOURCES = ['public/app.js', 'server.js', 'lib/hub.js', 'lib/store.js', 'lib/updater.js', 'lib/agents.js', 'lib/gemini.js', 'lib/providers.js'];

function loadDict(lang) {
  const dir = path.join(LOCALES, lang);
  const dict = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) Object.assign(dict, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  return dict;
}

// 代码里 tr('…') / tr("…") / tr(`…`)（不含 ${}）的字面量键
function keysIn(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const keys = [];
  const re = /\btr\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g;
  for (let m; (m = re.exec(src)); ) keys.push((m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)));
  return keys;
}

const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('译文文件都是合法 JSON', () => {
  for (const lang of fs.readdirSync(LOCALES)) loadDict(lang);
});

test('同一句原文在几份译文里的英文要一致', () => {
  const dir = path.join(LOCALES, 'en');
  const seen = {};
  const clash = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))) {
      if (k in seen && seen[k].v !== v) clash.push(`${k}：${seen[k].f} 是「${seen[k].v}」，${f} 是「${v}」`);
      else seen[k] = { f, v };
    }
  }
  assert.deepEqual(clash, [], `这些原文的英文不一致：\n${clash.join('\n')}`);
});

test('代码里每句 tr() 都有英文译文，占位符一致', () => {
  const en = loadDict('en');
  const missing = [];
  const badHoles = [];
  for (const f of SOURCES) {
    for (const k of keysIn(f)) {
      if (!/[一-鿿]/.test(k)) continue;
      if (!(k in en)) missing.push(`${f}: ${k}`);
      else if (holes(k) !== holes(en[k])) badHoles.push(`${f}: ${k} → ${en[k]}`);
    }
  }
  assert.deepEqual(missing, [], `这些文字还没有英文译文，请加到 public/locales/en/ 里：\n${missing.join('\n')}`);
  assert.deepEqual(badHoles, [], `这些译文的占位符和原文对不上：\n${badHoles.join('\n')}`);
});

test('tr：中文原样返回，英文查译文，查不到退回中文，占位符替换', () => {
  const was = getLang();
  try {
    setLang('zh');
    assert.equal(tr('已停止 {name}', { name: 'Claude' }), '已停止 Claude');
    setLang('en');
    assert.match(tr('已停止 {name}', { name: 'Claude' }), /Claude/);
    assert.doesNotMatch(tr('已停止 {name}', { name: 'Claude' }), /[一-鿿]/);
    assert.equal(tr('这句没有译文 {x}', { x: 1 }), '这句没有译文 1');
    setLang('fr'); // 不认识的语言不切换
    assert.equal(getLang(), 'en');
  } finally {
    setLang(was);
  }
});
