/*
 * tabs.js — 后台标签页导航（无依赖，dashboard 与 admin 共用）。
 *
 * 结构约定：
 *   <div role="tablist">
 *     <button role="tab" aria-controls="PANEL_ID">…</button>
 *   </div>
 *   <section role="tabpanel" id="PANEL_ID">…</section>
 *
 * 特性：
 *   - 点击与方向键（←/→/Home/End）切换，未选中标签移出 Tab 键序列（roving tabindex）
 *   - aria-selected 同步，Tailwind 用 aria-selected: 变体上样式
 *   - location.hash 深链：刷新或分享链接能回到同一标签
 *   - 标签首次显示时在 tablist 上派发 tab:show，页面据此按需拉数据，
 *     避免一进后台就把所有接口打满
 *
 * 用法（必须先挂监听再 init，否则首个标签的 tab:show 会在监听建立前派发）：
 *   const list = document.querySelector('[role="tablist"]');
 *   list.addEventListener("tab:show", (e) => load(e.detail.id));
 *   Tabs.init(list);
 *
 * 标签栏与面板通常不在同一父节点（标签栏吸顶、面板在 main 里），
 * 所以这里直接接收 tablist，面板一律按 aria-controls 的 id 全局查找。
 */
(function () {
  "use strict";

  function init(list) {
    if (typeof list === "string") list = document.querySelector(list);
    if (!list) return null;
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return null;

    const shown = new Set();
    const panelOf = (tab) => document.getElementById(tab.getAttribute("aria-controls"));

    function select(tab, opts) {
      if (!tab) return;
      const o = opts || {};
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        const p = panelOf(t);
        if (p) p.hidden = !on;
      }
      const id = tab.getAttribute("aria-controls");
      // replaceState 而非 pushState：切标签不该污染浏览器后退栈
      if (!o.silent) history.replaceState(null, "", "#" + id);
      if (o.focus) tab.focus();
      if (!shown.has(id)) {
        shown.add(id);
        list.dispatchEvent(new CustomEvent("tab:show", { detail: { id: id } }));
      }
    }

    list.addEventListener("click", (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (tab) select(tab);
    });

    list.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) {
        e.preventDefault();
        select(next, { focus: true });
      }
    });

    const fromHash = location.hash
      ? tabs.find((t) => "#" + t.getAttribute("aria-controls") === location.hash)
      : null;
    // 无深链时不写 hash，保持进入后台的地址干净
    select(fromHash || tabs[0], { silent: !fromHash });

    return {
      select: select,
      selectById: (id) => select(tabs.find((t) => t.getAttribute("aria-controls") === id)),
    };
  }

  window.Tabs = { init: init };
})();
