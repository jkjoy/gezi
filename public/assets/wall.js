/* 像素墙交互：
 *  - 拖选发布（Pointer Events，支持反向拖选与取消）
 *  - 内容块文字按占用格子等比例放大
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

  let config = { publishPriceP: 2, dailyPriceD: 1, textMax: 500 };
  let occupied = new Set(); // "x,y"，仅用于交互提示
  let loggedIn = false;
  let uploadedImage = null;
  let currentSel = null;

  // ---- 初始化 ----
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

  // ---- 文字等比例缩放 ----
  function cellDisplayPx() {
    return wall.clientWidth / GRID; // 每格当前显示像素
  }
  function fitFont(wCells, hCells) {
    const px = cellDisplayPx();
    const shortest = Math.min(wCells, hCells) * px; // 块短边像素
    return Math.max(7, Math.min(72, shortest * 0.5));
  }
  function applyFont(item) {
    const w = Number(item.dataset.w);
    const h = Number(item.dataset.h);
    if (w && h) item.style.fontSize = fitFont(w, h).toFixed(1) + "px";
  }

  // ---- 墙面渲染 ----
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
          applyFont(item);
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

  // ---- 悬停浮层 ----
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

  // ---- 拖选（Pointer Events）----
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

  // ---- 发布面板 ----
  function openPublishPanel() {
    if (!loggedIn) {
      location.href = "/dashboard.html";
      return;
    }
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
    $("in-x").value = currentSel.x;
    $("in-y").value = currentSel.y;
    $("in-w").value = currentSel.w;
    $("in-h").value = currentSel.h;
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
  }

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

  function bindEvents() {
    ["in-x", "in-y", "in-w", "in-h"].forEach((id) => $(id).addEventListener("input", updateFee));
    $("in-image").addEventListener("change", onUploadChange);
    $("btn-publish").addEventListener("click", onPublish);
    $("btn-cancel").addEventListener("click", cancelSelection);

    // 窗口尺寸变化时重算所有内容块文字大小（等比例保持）
    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        cellsEl.querySelectorAll(".cell-item").forEach(applyFont);
      }, 150);
    });
  }

  init();
})();
