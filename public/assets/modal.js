/*
 * modal.js — 轻量模态窗组件（无依赖）。
 * 提供：
 *   Modal.open({ title, icon, render, onConfirm, onClose, confirmText, danger, hideCancel })
 *   Modal.confirm({ title, message, icon, confirmText, danger })   确认对话（Promise<boolean>）
 *   Modal.alert({ title, message, icon, danger })                  单按钮提示（Promise<void>）
 * 特性：遮罩点击关闭、ESC 关闭、进入焦点、关闭恢复焦点、进出场动画、错误行、加载态。
 *
 * onConfirm 可为 async：期间按钮进入加载态，抛错时错误显示在模态内且不关闭——
 * 因此接口失败不需要再弹一层提示。
 *
 * 动画用 data-open + Tailwind group 变体驱动：遮罩带 group 与 data-open，
 * 卡片用 group-data-[open=true]:* 跟随父状态过渡，替代原先的 .open .modal 选择器。
 */
(function () {
  "use strict";
  const icon = (name, size) => (window.Icons ? Icons.svg(name, { size: size || 18 }) : "");

  // 进出场过渡。motion-reduce 下直接去掉过渡：既尊重系统的“减少动态效果”，
  // 也保证在不产出动画帧的环境里模态窗不会卡在全透明却仍捕获焦点。
  const OVERLAY_CLS =
    "group fixed inset-0 z-[200] flex items-start justify-center px-4 pt-[8vh] pb-4 " +
    "bg-[rgba(6,10,18,0.62)] backdrop-blur-[2px] " +
    "opacity-0 transition-opacity duration-150 motion-reduce:transition-none " +
    "data-[open=true]:opacity-100";

  const CARD_CLS =
    "w-full max-w-[460px] overflow-hidden rounded-xl border border-line bg-panel " +
    "shadow-[0_24px_60px_rgba(0,0,0,0.55)] " +
    "-translate-y-2 scale-[0.98] opacity-0 transition duration-150 motion-reduce:transition-none " +
    "group-data-[open=true]:translate-y-0 group-data-[open=true]:scale-100 " +
    "group-data-[open=true]:opacity-100";

  let overlay = null;
  let lastFocus = null;
  // 每次 open/close 递增。close 的清理是延时的（等出场动画），若这 160ms 内
  // 又打开了新模态，那次清理就已过期，必须放弃——否则会把新模态内容清空。
  // 连续弹窗（确认完再提示结果）依赖这个保护。
  let openSeq = 0;
  let onCloseCb = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = OVERLAY_CLS;
    overlay.dataset.open = "false";
    overlay.hidden = true;
    overlay.addEventListener("mousedown", (e) => {
      // 仅点击遮罩本身（非卡片内部）时关闭
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
    document.addEventListener("keydown", (e) => {
      if (!overlay.hidden && e.key === "Escape") close();
    });
    return overlay;
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    const seq = ++openSeq;
    overlay.dataset.open = "false";
    const cb = onCloseCb;
    onCloseCb = null;
    setTimeout(() => {
      if (seq !== openSeq) return; // 期间又打开了新模态，这次清理已过期
      overlay.hidden = true;
      overlay.innerHTML = "";
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
      lastFocus = null;
    }, 160);
    if (cb) cb();
  }

  /**
   * 通用模态。render(body) 用于填充自定义表单，返回一个 collect() 函数：
   * 点确认时调用 collect()，返回值传给 onConfirm(values)；collect 抛错则显示错误不关闭。
   * onConfirm 可为 async；期间按钮进入加载态；成功后自动关闭，失败显示错误。
   */
  function open(opts) {
    ensureOverlay();
    ++openSeq; // 作废任何挂起的关闭清理，允许紧接着上一个模态打开
    // 只在此前没有模态时记录归还焦点的目标，避免记成上一个模态里的按钮
    if (overlay.hidden) lastFocus = document.activeElement;
    onCloseCb = typeof opts.onClose === "function" ? opts.onClose : null;
    overlay.innerHTML = "";

    const card = document.createElement("div");
    card.className = CARD_CLS;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const head = document.createElement("div");
    head.className = "flex items-center justify-between px-[18px] pt-4 pb-2.5";
    head.innerHTML =
      `<h3 class="m-0 flex items-center gap-2 text-[17px] font-semibold">` +
      `<span class="ic ${opts.danger ? "text-err" : "text-accent"}">${opts.icon ? icon(opts.icon) : ""}</span>` +
      ` ${escapeHtml(opts.title || "")}</h3>`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className =
      "inline-flex cursor-pointer rounded-md border-none bg-transparent p-1 text-muted hover:bg-panel-2 hover:text-ink";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.innerHTML = icon("x", 18);
    closeBtn.addEventListener("click", close);
    head.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "max-h-[60vh] overflow-y-auto px-[18px] pt-1 pb-2";

    const err = document.createElement("p");
    err.className =
      "mx-[18px] rounded-md border border-err/30 bg-err/10 px-2.5 py-2 text-[13px] text-err";
    err.hidden = true;

    const foot = document.createElement("div");
    foot.className = "flex justify-end gap-2.5 px-[18px] pt-3.5 pb-[18px]";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn";
    cancelBtn.textContent = opts.cancelText || "取消";
    cancelBtn.addEventListener("click", close);
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "btn " + (opts.danger ? "btn-danger" : "btn-primary");
    okBtn.innerHTML = opts.confirmText || "确定";
    if (!opts.hideCancel) foot.appendChild(cancelBtn);
    foot.appendChild(okBtn);

    const collect = typeof opts.render === "function" ? opts.render(body) : null;

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(err);
    card.appendChild(foot);
    overlay.appendChild(card);
    overlay.hidden = false;
    // 先强制一次样式刷新，让起始态（opacity-0 / 位移）被提交，再同步切到 open
    // 触发过渡。不用 requestAnimationFrame：它在后台标签页和部分内嵌 webview 里
    // 会被节流甚至不触发，那样模态窗会永远停在全透明态，却仍捕获焦点挡住页面。
    void overlay.offsetHeight;
    overlay.dataset.open = "true";

    // 焦点：优先第一个可输入元素，否则确认按钮
    const focusTarget = body.querySelector("input, textarea, select") || okBtn;
    setTimeout(() => focusTarget.focus(), 60);

    const showErr = (msg) => {
      err.textContent = msg;
      err.hidden = false;
    };

    okBtn.addEventListener("click", async () => {
      err.hidden = true;
      let values;
      if (collect) {
        try {
          values = collect();
        } catch (e) {
          showErr(e && e.message ? e.message : String(e));
          return;
        }
      }
      if (!opts.onConfirm) return close();
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      const label = okBtn.innerHTML;
      okBtn.innerHTML = "处理中…";
      const cardBefore = overlay.firstElementChild;
      try {
        await opts.onConfirm(values);
        // onConfirm 内部可能已打开新的模态（如成功后的提示窗）：此时 overlay
        // 内容已被替换，外层的 close() 会把新模态立刻关掉，必须跳过。
        if (overlay.firstElementChild === cardBefore) close();
      } catch (e) {
        okBtn.disabled = false;
        cancelBtn.disabled = false;
        okBtn.innerHTML = label;
        showErr(e && e.message ? e.message : String(e));
      }
    });

    return { close, showErr };
  }

  /** 确认对话：resolve(true) 表示点了确认，遮罩/ESC/取消一律 resolve(false) */
  function confirm(opts) {
    return new Promise((resolve) => {
      let decided = false;
      open({
        title: opts.title || "确认",
        icon: opts.icon || "warning-circle",
        danger: opts.danger,
        confirmText: opts.confirmText || "确定",
        cancelText: opts.cancelText || "取消",
        render(body) {
          body.appendChild(messageEl(opts.message));
          return () => true;
        },
        onConfirm() { decided = true; resolve(true); },
        onClose() { if (!decided) resolve(false); },
      });
    });
  }

  /** 单按钮提示，替代 window.alert。resolve 于关闭时 */
  function alert(opts) {
    return new Promise((resolve) => {
      open({
        title: opts.title || "提示",
        icon: opts.icon || (opts.danger ? "warning-circle" : "check-circle"),
        danger: opts.danger,
        confirmText: opts.confirmText || "知道了",
        hideCancel: true,
        render(body) {
          body.appendChild(messageEl(opts.message));
          return () => true;
        },
        onConfirm() {},
        onClose() { resolve(); },
      });
    });
  }

  /** 提示正文：保留换行，供 confirm / alert 共用 */
  function messageEl(text) {
    const p = document.createElement("p");
    p.className = "my-1 text-sm leading-relaxed whitespace-pre-wrap";
    p.textContent = text || "";
    return p;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  window.Modal = { open, confirm, alert, close };
})();
