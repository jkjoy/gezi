/* 管理员后台：配置、用户搜索、批量赠送、捐助确认、日结与清理、审计日志 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const SETTING_FIELDS = [
    ["publishPriceP", "每格发布价格 P", 0, 1000000],
    ["dailyPriceD", "每格每日价格 D", 0, 1000000],
    ["registerReward", "注册奖励", 0, 1000000],
    ["inviteReward", "邀请奖励", 0, 1000000],
    ["inviteDailyCap", "邀请每日上限", 0, 1000],
    ["exchangeRate", "兑换率（积分/元）", 1, 1000000],
    ["donationMinFen", "捐助最低金额（分）", 1, 100000000],
    ["uploadMaxBytes", "上传大小上限（字节）", 1024, 20971520],
    ["uploadMaxWidth", "图片最大宽", 10, 4096],
    ["uploadMaxHeight", "图片最大高", 10, 4096],
    ["uploadMaxPixels", "图片总像素上限", 1024, 16777216],
    ["sessionTtlHours", "会话有效期（小时）", 1, 8760],
  ];

  async function init() {
    let me = null;
    try { me = await API.get("/api/auth/me"); } catch (_) {}
    if (!me || !me.user || me.user.role !== "admin") {
      document.body.innerHTML = '<div style="padding:40px;text-align:center">需要管理员权限，请先 <a href="/dashboard.html">登录</a>。</div>';
      return;
    }
    $("user-badge").textContent = `${me.user.username} · 管理员`;
    loadSettings();
    loadUsers();
    loadOrders();
    loadAudit();
    bindEvents();
  }

  async function loadSettings() {
    try {
      const s = (await API.get("/api/admin/settings")).settings;
      const form = $("settings-form");
      form.innerHTML = "";
      for (const [key, label, min, max] of SETTING_FIELDS) {
        const row = document.createElement("label");
        row.className = "field";
        row.innerHTML = `${label} <input type="number" name="${key}" value="${s[key]}" min="${min}" max="${max}">`;
        form.appendChild(row);
      }
    } catch (e) {
      $("settings-msg").className = "msg err";
      $("settings-msg").textContent = "加载失败：" + API.esc(e.message);
    }
  }

  async function loadUsers(q) {
    try {
      const data = await API.get(`/api/admin/users?q=${encodeURIComponent(q || "")}`);
      const box = $("users");
      if (!data.items.length) {
        box.innerHTML = '<p class="muted">没有匹配的用户</p>';
        return;
      }
      let html = '<table class="list"><tr><th>用户名</th><th>角色</th><th>余额</th><th>注册时间</th><th>用户 ID</th></tr>';
      for (const u of data.items) {
        html += `<tr>
          <td>${API.esc(u.username)}</td>
          <td>${u.role === "admin" ? '<span class="tag">admin</span>' : ""}</td>
          <td class="num">${u.balance}</td>
          <td class="muted">${API.fmtTime(u.createdAt)}</td>
          <td><code>${API.esc(u.id)}</code></td>
        </tr>`;
      }
      box.innerHTML = html + "</table>";
    } catch (e) {
      $("users").innerHTML = `<p class="msg err">加载失败：${API.esc(e.message)}</p>`;
    }
  }

  async function loadOrders() {
    try {
      const data = await API.get("/api/admin/donation-orders");
      const box = $("orders");
      if (!data.items.length) {
        box.innerHTML = '<p class="muted">暂无订单</p>';
        return;
      }
      box.innerHTML = "";
      for (const o of data.items) {
        const div = document.createElement("div");
        div.className = "order-item";
        const statusTag =
          o.status === "pending" ? '<span class="tag warn">待确认</span>'
          : o.status === "confirmed" ? '<span class="tag ok">已确认</span>'
          : '<span class="tag err">已取消</span>';
        div.innerHTML = `
          ${statusTag}
          <b>${API.esc(o.username)}</b>
          <span class="num">${(o.amountFen / 100).toFixed(2)} 元 → ${o.points} 积分</span>
          <span class="muted">快照 ${o.rateSnapshot}/元 · ${API.fmtTime(o.createdAt)}</span>
          ${o.txnNo ? `<span class="muted">已确认：${API.esc(o.channel || "")} ${API.esc(o.txnNo)}</span>` : ""}
        `;
        if (o.status === "pending") {
          const btn = document.createElement("button");
          btn.textContent = "确认到账";
          btn.addEventListener("click", () => confirmOrder(o));
          div.appendChild(btn);
        }
        box.appendChild(div);
      }
    } catch (e) {
      $("orders").innerHTML = `<p class="msg err">加载失败：${API.esc(e.message)}</p>`;
    }
  }

  function confirmOrder(o) {
    const channel = prompt(`确认订单 ${(o.amountFen / 100).toFixed(2)} 元（${o.username}）\n收款渠道（如 wx / alipay / bank）：`, "wx");
    if (!channel) return;
    const txnNo = prompt("到账交易号（同一渠道同一交易号只能关联一个订单）：");
    if (!txnNo) return;
    API.post(`/api/admin/donation-orders/${encodeURIComponent(o.id)}/confirm`, { channel, txnNo })
      .then((r) => {
        alert(r.already ? "该订单此前已确认，未重复入账" : `确认成功，已入账 ${o.points} 积分`);
        loadOrders();
      })
      .catch((e) => alert("确认失败：" + e.message));
  }

  let auditPage = 1;
  async function loadAudit() {
    try {
      const data = await API.get(`/api/admin/audit-logs?page=${auditPage}`);
      const box = $("audit");
      if (auditPage === 1) box.innerHTML = "";
      if (!data.items.length && auditPage === 1) {
        box.innerHTML = '<p class="muted">暂无记录</p>';
      }
      for (const a of data.items) {
        const div = document.createElement("div");
        div.className = "ledger-item";
        div.innerHTML = `<code>${API.esc(a.action)}</code> <span class="muted">${API.esc(a.objectType || "")} ${API.esc(a.objectId || "")} · ${API.fmtTime(a.createdAt)}</span>`;
        box.appendChild(div);
      }
      $("btn-audit-more").hidden = auditPage * data.size >= data.total;
    } catch (e) {
      $("audit").innerHTML = `<p class="msg err">加载失败：${API.esc(e.message)}</p>`;
    }
  }

  function bindEvents() {
    $("btn-logout").addEventListener("click", async () => {
      try { await API.post("/api/auth/logout"); } catch (_) {}
      location.href = "/";
    });
    $("settings-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {};
      for (const [key] of SETTING_FIELDS) {
        const v = Number(e.target.elements[key].value);
        if (Number.isFinite(v)) body[key] = Math.trunc(v);
      }
      try {
        await API.put("/api/admin/settings", body);
        $("settings-msg").className = "msg ok";
        $("settings-msg").textContent = "已保存。费率只影响之后的新发布内容。";
      } catch (err) {
        $("settings-msg").className = "msg err";
        $("settings-msg").textContent = "保存失败：" + API.esc(err.message);
      }
    });
    $("user-search").addEventListener("submit", (e) => {
      e.preventDefault();
      loadUsers($("user-q").value.trim());
    });
    $("bulk-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const ids = $("bulk-users").value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return;
      try {
        const r = await API.post("/api/admin/bulk-grants", {
          userIds: ids,
          amount: Math.trunc(Number($("bulk-amount").value) || 0),
          reason: $("bulk-reason").value.trim(),
        });
        $("bulk-result").innerHTML = `<p class="msg ok">批次 ${API.esc(r.batchId)}：成功 ${r.succeeded}，失败 ${r.failed}，剩余 ${r.remaining}。</p>`;
        loadUsers($("user-q").value.trim());
      } catch (err) {
        $("bulk-result").innerHTML = `<p class="msg err">发放失败：${API.esc(err.message)}</p>`;
      }
    });
    $("btn-run-settlement").addEventListener("click", async () => {
      $("ops-result").textContent = "日结执行中…";
      try {
        const r = await API.post("/api/admin/settlement/run");
        $("ops-result").textContent = JSON.stringify(r.stats, null, 2);
      } catch (e) { $("ops-result").textContent = "失败：" + e.message; }
    });
    $("btn-run-cleanup").addEventListener("click", async () => {
      $("ops-result").textContent = "清理执行中…";
      try {
        const r = await API.post("/api/admin/cleanup/run");
        $("ops-result").textContent = JSON.stringify(r.stats, null, 2);
      } catch (e) { $("ops-result").textContent = "失败：" + e.message; }
    });
    $("btn-audit-more").addEventListener("click", () => { auditPage++; loadAudit(); });
  }

  init();
})();
