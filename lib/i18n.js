import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 多语言：代码里写中文原文，tr('已停止 {name}', { name }) 按当前语言查 public/locales/<语言>/*.json 里的译文，查不到就用中文原文。
// 前端（public/i18n.js）用的是同一份译文；服务端的语言由前端告诉它（老板在设置里选的，或者跟随系统）。
export const LANGS = ['zh', 'en'];
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');

// 每种语言一个文件夹，里面按地方分几份（app.json、html.json、server.json…），合在一起用；各管各的，改的时候不容易撞车
const dicts = {};
for (const l of LANGS) {
  if (l === 'zh') continue;
  dicts[l] = {};
  let files = [];
  try {
    files = fs.readdirSync(path.join(DIR, l)).filter((f) => f.endsWith('.json')).sort();
  } catch {}
  for (const f of files) {
    try {
      Object.assign(dicts[l], JSON.parse(fs.readFileSync(path.join(DIR, l, f), 'utf8')));
    } catch (err) {
      console.error(`[clawchat] 译文文件 ${l}/${f} 读不了：${err.message}`);
    }
  }
}

// 默认中文；界面打开后前端会告诉服务端实际用的语言（存进 config.json 的 uiLang，下次启动直接用）
let current = 'zh';

export function setLang(l) {
  if (LANGS.includes(l)) current = l;
  return current;
}

export const getLang = () => current;

export function fill(s, vars) {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

export function tr(s, vars) {
  return fill((current !== 'zh' && dicts[current]?.[s]) || s, vars);
}

// 给浏览器的译文（/i18n-dict.js），在 app.js 之前同步加载，界面第一次画出来就是对的语言
export const dictScript = () => `window.I18N_DICTS=${JSON.stringify(dicts)};`;
