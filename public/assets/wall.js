/* 像素墙交互：
 *  - 拖选发布（Pointer Events，支持反向拖选与取消）
 *  - 纯文字内容块自适应字号：canvas 测量折行，二分查找"能完整显示的最大字号"
 *  - 发布面板：文字实时预览 + 推荐完整显示所需格数，一键应用推荐尺寸
 *  - 点击有链接的内容块直接打开链接（http/https，新窗口 noopener）
 *  - 鼠标悬停显示完整信息（全文、位置尺寸、链接）
 */
(function () {
  "use strict";
  const GRID = 100;
  const $ = (id) => document.getElementById(id);

  const wall = $("wall");
  const overlay = $("grid-overlay");
  const cellsEl = $("cells");
  const selEl = $("selection");
  const panelView = $("panel-view");
  const panelSelect = $("panel-select");
  const occupiedInfo = $("occupied-info");
  const feePreview = $("fee-preview");
  const publishMsg = $("publish-msg");
  const tooltip = $("cell-tooltip");
  const textFitBlock = $("text-fit-block");
  const textFitInfo = $("text-fit-info");
  const textPreview = $("text-preview");
  const btnUseRec = $("btn-use-rec");

  let config = { publishPriceP: 2, dailyPriceD: 1, textMax: 500 };
  let occupied = new Set(); // "x,y"，仅用于交互提示
  let loggedIn = false;
  let uploadedImage = null;
  let currentSel = null;
  let currentRec = null; // 当前推荐的区域 { w, h }

  /* ---------------- 文字测量与自适应 ---------------- */
  // 字体栈需与 .cell-item 的 CSS font-family 一致，保证测量与实际渲染同宽
  const FONT_STACK = 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
  const FIT_LINE_HEIGHT = 1.18; // 预估行高（略大于 CSS 实际 1.15，留安全余量）
  const FIT_MIN_PX = 7;         // 字号下限：低于此值不可读
  const FIT_MAX_PX = 72;        // 字号上限
  const READABLE_PX = 12;       // 可读性参考字号（推荐尺寸按此目标计算）
  const BOX_PAD = 6;            // 内容块内边距 + 边框预留（px）

  const measureCtx = document.createElement("canvas").getContext("2d");

  function isCJK(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
  }

  // 分词：CJK 逐字可断行；连续非 CJK（英文单词 + 空格）作为整体；换行符独立成词
  function tokenizeText(text) {
    const tokens = [];
    let word = "";
    for (const ch of text) {
      if (ch === "\n") {
        if (word) { tokens.push(word); word = ""; }
        tokens.push("\n");
      } else if (isCJK(ch)) {
        if (word) { tokens.push(word); word = ""; }
        tokens.push(ch);
      } else {
        word += ch;
      }
    }
    if (word) tokens.push(word);
    return tokens;
  }

  // 按最大宽度折行，返回行数组（近似浏览器断行：CJK 逐字、英文按词）
  function wrapTokens(tokens, fs, maxW) {
    measureCtx.font = fs + "px " + FONT_STACK;
    const lines = [];
    let line = "";
    for (const t of tokens) {
      if (t === "\n") { lines.push(line); line = ""; continue; }
      if (line === "") { line = t; continue; }
      if (measureCtx.measureText(line + t).width <= maxW) line += t;
      else { lines.push(line); line = t; }
    }
    if (line !== "" || lines.length === 0) lines.push(line);
    return lines;
  }

  // 二分查找能完整放进 box（宽高 px）的最大字号；最小字号仍放不下时 fits=false
  function fitText(text, boxW, boxH) {
    if (boxW <= 2 || boxH <= 2) return { size: FIT_MIN_PX, fits: false };
    const tokens = tokenizeText(text);
    const fits = (fs) => wrapTokens(tokens, fs, boxW).length * fs * FIT_LINE_HEIGHT <= boxH + 0.5;
    if (!fits(FIT_MIN_PX)) return { size: FIT_MIN_PX, fits: false };
    let lo = FIT_MIN_PX;
    let hi = FIT_MAX_PX;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    return { size: lo, fits: true };
  }

  // 在目标字号下，推荐能完整显示的最小格数区域（长宽比限制 1:4，避免细长条）
  function recommendSize(text, targetFs, cellPx) {
    measureCtx.font = targetFs + "px " + FONT_STACK;
    const oneLineW = Math.max(1, measureCtx.measureText(text.replace(/\n/g, "")).width);
    const forced = (text.match(/\n/g) || []).length;
    let best = null;
    for (let w = 1; w <= GRID; w++) {
      const boxW = w * cellPx - BOX_PAD;
      if (boxW <= 0) continue;
      const lines = Math.ceil(oneLineW / boxW) + forced;
      const h = Math.max(1, Math.ceil((lines * targetFs * FIT_LINE_HEIGHT + BOX_PAD) / cellPx));
      if (h > GRID) continue;
      const area = w * h;
      const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
      const score = area * (aspect > 4 ? 1000 : 1); // 细长区域加惩罚
      if (!best || score < best.score) best = { w, h, score };
    }
    if (!best) return null;
    // 行数近似可能比真实折行少一行：用 fitText 实测校验，不足则增高，
    // 保证应用推荐后目标字号真的放得下（避免"推荐尺寸=当前尺寸"的无效循环）
    const w = best.w;
    let h = best.h;
    while (h <= GRID) {
      const fit = fitText(text, w * cellPx - BOX_PAD, h * cellPx - BOX_PAD);
      if (fit.fits && fit.size >= targetFs) return { w, h };
      h++;
    }
    return null;
  }

  function cellPxNow() {
    return wall.clientWidth / GRID;
  }

  // 内容块：按当前渲染尺寸自适应字号，放不下时标记 cell-clip（悬停浮层可看全文）
  function fitItem(item, cellPx) {
    const text = item.dataset.text;
    if (!text) return;
    const w = Number(item.dataset.w) || 1;
    const h = Number(item.dataset.h) || 1;
    const fit = fitText(text, w * cellPx - BOX_PAD, h * cellPx - BOX_PAD);
    item.style.fontSize = fit.size.toFixed(1) + "px";
    item.classList.toggle("cell-clip", !fit.fits);
  }

  function fitAllItems() {
    const cellPx = cellPxNow();
    cellsEl.querySelectorAll(".cell-item[data-text]").forEach((el) => fitItem(el, cellPx));
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
    try {
      config = await API.get("/api/config");
    } catch (_) { /* 用默认配置 */ }
    overlay.style.backgroundSize = `${100 / GRID}% ${100 / GRID}%`;
    try {
      const me = await API.get("/api/auth/me");
      loggedIn = !!me.user;
      if (me.user) {
        $("nav-dashboard").innerHTML =
          `${iconTag("user-circle", 16)} 我的后台 (${API.esc(me.user.username)})`;
        if (me.user.role === "admin") $("nav-admin").hidden = false;
      }
    } catch (_) { /* 未登录 */ }
    const ref = new URLSearchParams(location.search).get("ref");
    if (ref) reportInvite(ref);
    await loadWall();
    bindEvents();
  }

  function iconTag(name, size) {
    return window.Icons ? Icons.svg(name, { size: size || 16 }) : "";
  }

  async function reportInvite(code) {
    try {
      const r = await API.post("/api/invite/visit", { code });
      if (r.rewarded) occupiedInfo.textContent = "通过邀请链接访问成功，邀请人已获得积分奖励。";
    } catch (_) { /* 静默 */ }
  }

  /* ---------------- 墙面渲染 ---------------- */
  async function loadWall() {
    try {
      const data = await API.get("/api/wall");
      occupied = new Set();
      cellsEl.textContent = "";
      for (const p of data.posts) {
        for (let dx = 0; dx < p.width; dx++)
          for (let dy = 0; dy < p.height; dy++) occupied.add(`${p.x + dx},${p.y + dy}`);

        const item = document.createElement("div");
        item.className = `cell-item tint-${(hashCode(p.id) % 5) + 1}`;
        item.style.left = `${p.x}%`;
        item.style.top = `${p.y}%`;
        item.style.width = `${p.width}%`;
        item.style.height = `${p.height}%`;
        item.dataset.w = String(p.width);
        item.dataset.h = String(p.height);

        const link = API.safeLink(p.link);
        if (link) {
          item.dataset.link = link;
          item.classList.add("has-link");
        }

        if (p.image) {
          const img = document.createElement("img");
          img.src = p.image;
          img.alt = "";
          img.loading = "lazy";
          item.appendChild(img);
        } else if (p.text) {
          const span = document.createElement("span");
          span.className = "cell-text";
          span.textContent = p.text;
          item.appendChild(span);
          item.dataset.text = p.text;
        }

        // 点击：有链接直接打开
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          const l = item.dataset.link;
          if (l) window.open(l, "_blank", "noopener,noreferrer");
        });
        // 悬停：显示完整信息
        item.addEventListener("mouseenter", () => showTip(p));
        item.addEventListener("mousemove", moveTip);
        item.addEventListener("mouseleave", hideTip);

        cellsEl.appendChild(item);
      }
      fitAllItems();
      const free = GRID * GRID - occupied.size;
      occupiedInfo.textContent = `已占用 ${occupied.size} / ${GRID * GRID} 格，剩余 ${free} 格。`;
    } catch (e) {
      occupiedInfo.textContent = "像素墙加载失败：" + API.esc(e.message);
    }
  }

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  /* ---------------- 悬停浮层 ---------------- */
  function showTip(p) {
    const link = API.safeLink(p.link);
    tooltip.innerHTML = `
      ${p.text ? `<div class="tip-text">${API.esc(p.text)}</div>` : '<div class="tip-text muted">（图片内容）</div>'}
      <div class="tip-meta">位置 (${p.x}, ${p.y}) · 尺寸 ${p.width}×${p.height}</div>
      ${link ? `<div class="tip-link">${iconTag("arrow-square-out", 13)} 点击打开：${API.esc(link)}</div>` : '<div class="tip-meta muted">无链接</div>'}
    `;
    tooltip.hidden = false;
  }
  function moveTip(e) {
    const pad = 14;
    const r = tooltip.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    tooltip.style.left = Math.max(4, x) + "px";
    tooltip.style.top = Math.max(4, y) + "px";
  }
  function hideTip() {
    tooltip.hidden = true;
  }

  /* ---------------- 拖选（Pointer Events）---------------- */
  let dragging = false;
  let startCell = null;

  function cellFromEvent(e) {
    const rect = wall.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID);
    return { x: Math.max(0, Math.min(GRID - 1, x)), y: Math.max(0, Math.min(GRID - 1, y)) };
  }
  function drawSelection(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x) + 1;
    const h = Math.abs(a.y - b.y) + 1;
    currentSel = { x, y, w, h };
    selEl.hidden = false;
    selEl.style.left = `${x}%`;
    selEl.style.top = `${y}%`;
    selEl.style.width = `${w}%`;
    selEl.style.height = `${h}%`;
  }

  wall.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".cell-item")) return; // 点击已占用块走打开链接
    wall.setPointerCapture(e.pointerId);
    dragging = true;
    startCell = cellFromEvent(e);
    drawSelection(startCell, startCell);
    e.preventDefault();
  });
  wall.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    drawSelection(startCell, cellFromEvent(e));
  });
  wall.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    drawSelection(startCell, cellFromEvent(e));
    openPublishPanel();
  });
  wall.addEventListener("pointercancel", () => {
    dragging = false;
    cancelSelection();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancelSelection();
  });

  function cancelSelection() {
    currentSel = null;
    selEl.hidden = true;
    panelSelect.hidden = true;
    panelView.hidden = false;
  }

  /* ---------------- 发布面板 ---------------- */
  function updateOverlapWarning() {
    if (!currentSel) return;
    let overlap = 0;
    for (let dx = 0; dx < currentSel.w; dx++)
      for (let dy = 0; dy < currentSel.h; dy++)
        if (occupied.has(`${currentSel.x + dx},${currentSel.y + dy}`)) overlap++;
    if (overlap > 0) {
      publishMsg.className = "msg err";
      publishMsg.textContent = `所选区域与已占用内容重叠（${overlap} 格），请重新选择。`;
    } else {
      publishMsg.textContent = "";
      publishMsg.className = "msg";
    }
  }

  function openPublishPanel() {
    if (!loggedIn) {
      location.href = "/dashboard.html";
      return;
    }
    if (!currentSel) return;
    $("in-x").value = currentSel.x;
    $("in-y").value = currentSel.y;
    $("in-w").value = currentSel.w;
    $("in-h").value = currentSel.h;
    updateOverlapWarning();
    updateFee();
    panelView.hidden = true;
    panelSelect.hidden = false;
  }

  function readSel() {
    const x = Math.max(0, Math.min(99, Math.floor(Number($("in-x").value) || 0)));
    const y = Math.max(0, Math.min(99, Math.floor(Number($("in-y").value) || 0)));
    const w = Math.max(1, Math.min(100 - x, Math.floor(Number($("in-w").value) || 1)));
    const h = Math.max(1, Math.min(100 - y, Math.floor(Number($("in-h").value) || 1)));
    return { x, y, w, h };
  }

  function updateFee() {
    const sel = readSel();
    currentSel = sel;
    selEl.hidden = false;
    selEl.style.left = `${sel.x}%`;
    selEl.style.top = `${sel.y}%`;
    selEl.style.width = `${sel.w}%`;
    selEl.style.height = `${sel.h}%`;
    const area = sel.w * sel.h;
    feePreview.textContent =
      `面积 ${sel.w}×${sel.h} = ${area} 格 · 发布费 ${area * config.publishPriceP}` +
      ` · 每日 ${area * config.dailyPriceD} 积分`;
    updateTextFit();
  }

  /* ---------------- 文字适配提示与预览 ---------------- */
  function updateTextFit() {
    const text = $("in-text").value;
    if (!text.trim()) {
      textFitBlock.hidden = true;
      currentRec = null;
      btnUseRec.hidden = true;
      return;
    }
    textFitBlock.hidden = false;
    const sel = readSel();
    const cellPx = cellPxNow();
    const boxW = sel.w * cellPx - BOX_PAD;
    const boxH = sel.h * cellPx - BOX_PAD;
    const fit = fitText(text, boxW, boxH);

    let cls = "ok";
    let msg = "";
    let rec = null;
    if (fit.fits && fit.size >= READABLE_PX) {
      msg = `当前区域可完整显示，字号约 ${fit.size}px`;
    } else if (fit.fits) {
      rec = recommendSize(text, READABLE_PX, cellPx);
      cls = "warn";
      msg = rec
        ? `可完整显示，但字号仅 ${fit.size}px（偏小）。推荐 ${rec.w}×${rec.h} 格（按当前窗口估算）`
        : `可完整显示，但字号仅 ${fit.size}px（偏小）；推荐尺寸超出墙面，建议扩大区域`;
    } else {
      rec = recommendSize(text, READABLE_PX, cellPx);
      cls = "err";
      msg = rec
        ? `文字较多，当前区域会显示不全。完整显示约需 ${rec.w}×${rec.h} 格（按当前窗口估算）`
        : `文字过多，即使占满整墙也无法完整显示，请精简文字`;
    }
    textFitInfo.className = "text-fit " + cls;
    textFitInfo.textContent = msg;
    currentRec = rec;
    btnUseRec.hidden = !rec;

    renderPreview(text, boxW, boxH, fit);
  }

  // 等比缩放预览：布局比例与墙上完全一致（字号与宽高同乘 scale），小区域放大、大区域缩小
  function renderPreview(text, boxW, boxH, fit) {
    if (boxW <= 0 || boxH <= 0) {
      textPreview.style.display = "none";
      return;
    }
    textPreview.style.display = "flex";
    const scale = Math.min(280 / boxW, 200 / boxH, 56 / Math.max(1, fit.size));
    textPreview.style.width = Math.max(24, Math.round(boxW * scale)) + "px";
    textPreview.style.height = Math.max(18, Math.round(boxH * scale)) + "px";
    textPreview.style.fontSize = (fit.size * scale).toFixed(1) + "px";
    textPreview.textContent = text;
    textPreview.classList.toggle("clip", !fit.fits);
  }

  function applyRecommended() {
    if (!currentRec) return;
    // 应用推荐尺寸；若超出右/下边界则平移起点，保持区域完整
    $("in-x").value = Math.max(0, Math.min(Number($("in-x").value) || 0, GRID - currentRec.w));
    $("in-y").value = Math.max(0, Math.min(Number($("in-y").value) || 0, GRID - currentRec.h));
    $("in-w").value = currentRec.w;
    $("in-h").value = currentRec.h;
    updateFee();
    updateOverlapWarning(); // 扩大后的区域可能与其他内容重叠
  }

  /* ---------------- 图片上传 ---------------- */
  async function onUploadChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    uploadedImage = null;
    publishMsg.className = "msg";
    publishMsg.textContent = "上传中…";
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await API.upload("/api/uploads", fd);
      uploadedImage = { id: data.id, url: data.url };
      const img = $("img-preview");
      img.src = data.url;
      img.hidden = false;
      publishMsg.textContent = "";
    } catch (err) {
      publishMsg.className = "msg err";
      publishMsg.textContent = "图片上传失败：" + API.esc(err.message);
      $("img-preview").hidden = true;
    }
  }

  /* ---------------- 发布 ---------------- */
  let publishInflight = false;
  let lastRequestId = null;

  async function onPublish() {
    if (publishInflight || !currentSel) return;
    const sel = readSel();
    const text = $("in-text").value.trim();
    const link = API.safeLink($("in-link").value.trim());
    if (!text && !uploadedImage) {
      publishMsg.className = "msg err";
      publishMsg.textContent = "内容至少包含文字或图片";
      return;
    }
    if ($("in-link").value.trim() && !link) {
      publishMsg.className = "msg err";
      publishMsg.textContent = "链接必须以 http:// 或 https:// 开头";
      return;
    }
    if (!lastRequestId) lastRequestId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const body = {
      requestId: lastRequestId,
      x: sel.x, y: sel.y, width: sel.w, height: sel.h,
      text, link, imageId: uploadedImage ? uploadedImage.id : null,
    };
    publishInflight = true;
    const btn = $("btn-publish");
    btn.disabled = true;
    publishMsg.className = "msg";
    publishMsg.textContent = "发布中…";
    try {
      await API.post("/api/posts", body);
      publishMsg.className = "msg ok";
      publishMsg.textContent = "发布成功！";
      lastRequestId = null;
      uploadedImage = null;
      $("in-text").value = "";
      $("in-link").value = "";
      $("in-image").value = "";
      $("img-preview").hidden = true;
      await loadWall();
      setTimeout(cancelSelection, 600);
    } catch (err) {
      publishMsg.className = "msg err";
      if (err.code === "area_conflict") {
        publishMsg.textContent = "所选区域已被他人占用，请重新选择";
        await loadWall();
        lastRequestId = null;
      } else if (err.code === "request_conflict") {
        publishMsg.textContent = "请求 ID 冲突，请刷新页面后重试";
        lastRequestId = null;
      } else {
        publishMsg.textContent = "发布失败：" + API.esc(err.message);
        if (err.code !== "insufficient_balance") lastRequestId = null;
      }
    } finally {
      publishInflight = false;
      btn.disabled = false;
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    ["in-x", "in-y", "in-w", "in-h"].forEach((id) => $(id).addEventListener("input", updateFee));
    $("in-text").addEventListener("input", updateTextFit);
    $("in-image").addEventListener("change", onUploadChange);
    $("btn-publish").addEventListener("click", onPublish);
    $("btn-cancel").addEventListener("click", cancelSelection);
    $("btn-use-rec").addEventListener("click", applyRecommended);

    // 窗口尺寸变化：重算所有内容块字号；面板打开时同步更新推荐信息
    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAllItems();
        if (!panelSelect.hidden) updateTextFit();
      }, 150);
    });
  }

  init();
})();
