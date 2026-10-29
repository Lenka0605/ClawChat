'use strict';

// 多语言：代码里写中文原文，tr('已停止 {name}', { name }) 按当前语言查 public/locales/<语言>/*.json 的译文，查不到就显示中文原文。
// 语言在「设置 → 通用 → 语言」里选，默认跟随系统（系统是中文就用中文，否则用英文）。index.html 里写死的文字在这里统一换掉。
const I18N = (() => {
  const LANGS = ['zh', 'en'];
  const KEY = 'clawchat.lang';
  const pref = (() => {
    try {
      const v = localStorage.getItem(KEY);
      return LANGS.includes(v) ? v : 'system';
    } catch {
      return 'system';
    }
  })();
  const systemLang = () => (/^zh/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '') ? 'zh' : 'en');
  const lang = pref === 'system' ? systemLang() : pref;
  const dict = (lang !== 'zh' && (window.I18N_DICTS || {})[lang]) || {};
  const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
  const tr = (s, vars) => fill(dict[s] || s, vars);

  // 换掉静态页面里的文字：文字节点按去掉首尾空白后的原文查；常见的几个属性也换
  const ATTRS = ['title', 'placeholder', 'aria-label', 'data-title', 'data-placeholder'];
  function translateDom(root) {
    const walk = (node) => {
      const it = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = it.currentNode; n; n = it.nextNode()) {
        if (n.nodeType === 3) {
          const s = n.nodeValue.trim();
          if (s && dict[s]) n.nodeValue = n.nodeValue.replace(s, dict[s]);
          continue;
        }
        if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') continue;
        for (const a of ATTRS) {
          const v = n.getAttribute && n.getAttribute(a);
          if (v && dict[v]) n.setAttribute(a, dict[v]);
        }
        if (n.tagName === 'TEMPLATE') walk(n.content);
      }
    };
    walk(root);
  }

  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.documentElement.dataset.lang = lang;
  if (lang !== 'zh') {
    translateDom(document.body);
    document.title = tr(document.title);
  }

  return {
    lang,
    pref,
    systemLang,
    tr,
    fill,
    setPref(v) {
      try {
        if (LANGS.includes(v)) localStorage.setItem(KEY, v);
        else localStorage.removeItem(KEY);
      } catch {}
    },
  };
})();
const tr = I18N.tr;
