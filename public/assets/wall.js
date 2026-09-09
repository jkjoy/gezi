/* 像素墙交互：拖选（Pointer Events，支持反向拖选与取消）、发布、详情 */
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
  const panelDetail = $("panel-detail");
  const occupiedInfo = $("occupied-info");
  const feePreview = $("fee-preview");
  const publishMsg = $("publish-msg");

  let config = { publishPriceP: 2, dailyPriceD: 1, textMax: 500 };
  let occupied = new Set(); // "x,y" 集合，仅用于交互提示
  let loggedIn = false;
  let uploadedImage = null; // { id, key }
  let currentSel = null; // { x, y, w, h }

  // ---- 初始化 ----
  async function init() {
    try {
      config = await API.get("/api/config");
      document.querySelector('meta[name="viewport"]');
    } catch (_) { /* 使用默认配置 */ }
    overlay.style.backgroundSize = `${100 / GRID}% ${100 / GRID}%`;
    try {
      const me = await API.get("/api/auth/me");
      loggedIn = !!me.user;
      if (me.user) {
        $("nav-dashboard").textContent = `我的后台 (${me.user.username})`;
        if (me.user.role === "admin") $("nav-admin").hidden = false;
      }
    } catch (_) { /* 未登录 */ }
    const ref = new URLSearchParams(location.search).get("ref");
    if (ref) reportInvite(ref);
    await loadWall();
    bindEvents();
  }

  async function reportInvite(code) {
    try {
      const r = await API.post("/api/invite/visit", { code });
      if (r.rewarded) {
        occupiedInfo.textContent = "通过邀请链接访问成功，邀请人已获得积分奖励。";
      }
    } catch (_) { /* 静默失败：无效邀请码等情况 */ }
  }

  async function loadWall() {
    try {
      const data = await API.get("/api/wall");
      occupied = new Set();
      cellsEl.textContent = "";
      for (const p of data.posts) {
        for (let dx = 0; dx < p.width; dx++) {
          for (let dy = 0; dy < p.height; dy++) {
            occupied.add(`${p.x + dx},${p.y + dy}`);
          }
        }
        const item = document.createElement("div");
        item.className = `cell-item tint-${(hashCode(p.id) % 5) + 1}`;
        item.style.left = `${p.x}%`;
        item.style.top = `${p.y}%`;
        item.style.width = `${p.width}%`;
        item.style.height = `${p.height}%`;
        item.dataset.postId = p.id;
        if (p.image) {
          const img = document.createElement("img");
          img.src = p.image;
          img.alt = "";
          img.loading = "lazy";
          item.appendChild(img);
        } else if (p.text) {
          item.textContent = p.text.length > 80 ? p.text.slice(0, 80) + "…" : p.text;
        }
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          showDetail(p.id);
        });
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

  // ---- 拖选（Pointer Events，桌面与触屏统一）----
  let dragging = false;
  let startCell = null;

  function cellFromEvent(e) {
    const rect = wall.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID);
    return { x: Math.max(0, Math.min(GRID - 1, x)), y: Math.max(0, Math.min(GRID - 1, y)) };
  }

  function drawSelection(a, b) {
    // 反向拖选也归一化为正矩形
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
    if (e.target.closest(".cell-item")) return; // 点击已占用区域走详情
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
    const end = cellFromEvent(e);
    drawSelection(startCell, end);
    openPublishPanel();
  });

  wall.addEventListener("pointercancel", () => {
    dragging = false;
    cancelSelection();
  });

  // 键盘操作：方向键 + 回车（配合坐标输入框）
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancelSelection();
  });

  function cancelSelection() {
    currentSel = null;
    selEl.hidden = true;
    panelSelect.hidden = true;
    panelView.hidden = false;
    panelDetail.hidden = true;
  }

  // ---- 发布面板 ----
  function openPublishPanel() {
    if (!loggedIn) {
      location.href = "/dashboard.html";
      return;
    }
    if (!currentSel) return;
    // 检查选中区域是否与已占用格重叠（服务端最终裁决）
    let overlap = 0;
    for (let dx = 0; dx < currentSel.w; dx++) {
      for (let dy = 0; dy < currentSel.h; dy++) {
        if (occupied.has(`${currentSel.x + dx},${currentSel.y + dy}`)) overlap++;
      }
    }
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
    panelDetail.hidden = true;
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
    // 客户端生成业务请求 ID：网络超时后重试复用同一 ID，防止重复扣费
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
      const data = await API.post("/api/posts", body);
      publishMsg.className = "msg ok";
      publishMsg.textContent = "发布成功！";
      lastRequestId = null;
      uploadedImage = null;
      $("in-text").value = "";
      $("in-link").value = "";
      $("in-image").value = "";
      $("img-preview").hidden = true;
      await loadWall();
      setTimeout(() => cancelSelection(), 600);
    } catch (err) {
      publishMsg.className = "msg err";
      if (err.code === "area_conflict") {
        publishMsg.textContent = "所选区域已被他人占用（价格或占用可能已变化），请重新选择";
        await loadWall();
        lastRequestId = null; // 冲突后允许换区域，使用新请求 ID
      } else if (err.code === "request_conflict") {
        publishMsg.textContent = "请求 ID 冲突，请刷新页面后重试";
        lastRequestId = null;
      } else {
        publishMsg.textContent = "发布失败：" + API.esc(err.message);
        // 余额不足等业务错误后，重试需要新请求（内容可能变化）
        if (err.code !== "insufficient_balance") lastRequestId = null;
      }
    } finally {
      publishInflight = false;
      btn.disabled = false;
    }
  }

  // ---- 详情 ----
  async function showDetail(postId) {
    try {
      const data = await API.get(`/api/posts/${encodeURIComponent(postId)}`);
      const p = data.post;
      const body = $("detail-body");
      const safeLink = API.safeLink(p.link);
      body.innerHTML = `
        <p class="muted">位置 (${p.x}, ${p.y}) · 尺寸 ${p.width}×${p.height} · 发布于 ${API.fmtTime(p.createdAt)}</p>
        <p class="muted">发布者 ${API.esc(p.owner)}</p>
        ${p.image ? `<img src="${API.esc(p.image)}" alt="内容图片" style="max-width:100%;border-radius:6px">` : ""}
        ${p.text ? `<p style="white-space:pre-wrap">${API.esc(p.text)}</p>` : ""}
        ${safeLink ? `<p><a href="${API.esc(safeLink)}" target="_blank" rel="noopener noreferrer">打开链接 ↗</a></p>` : ""}
      `;
      panelView.hidden = true;
      panelSelect.hidden = true;
      panelDetail.hidden = false;
    } catch (e) {
      occupiedInfo.textContent = "详情加载失败：" + API.esc(e.message);
    }
  }

  function bindEvents() {
    ["in-x", "in-y", "in-w", "in-h"].forEach((id) => $(id).addEventListener("input", updateFee));
    $("in-image").addEventListener("change", onUploadChange);
    $("btn-publish").addEventListener("click", onPublish);
    $("btn-cancel").addEventListener("click", cancelSelection);
    $("btn-close-detail").addEventListener("click", () => {
      panelDetail.hidden = true;
      panelView.hidden = false;
    });
  }

  init();
})();
