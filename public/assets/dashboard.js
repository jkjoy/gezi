/* 用户后台：账户、我的内容（编辑/删除）、流水、捐助订单 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let me = null;

  async function init() {
    try {
      me = await API.get("/api/auth/me");
    } catch (_) { /* 未登录 */ }
    if (!me || !me.user) {
      showAuthForm();
      return;
    }
    $("user-badge").textContent = `${me.user.username} · ${me.user.balance} 积分`;
    loadAccount();
    loadMyPosts();
    loadLedger();
    loadOrders();
    bindEvents();
  }

  function showAuthForm() {
    const info = $("account-info");
    info.innerHTML = `
      <form id="auth-form" class="stack-form">
        <label>用户名 <input name="username" autocomplete="username" required></label>
        <label>密码 <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit" id="auth-login">登录</button>
        <button type="button" id="auth-register">注册新账户</button>
        <p class="msg" id="auth-msg"></p>
      </form>
    `;
    const form = $("auth-form");
    let mode = "login";
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await API.post(`/api/auth/${mode}`, {
          username: String(fd.get("username") || ""),
          password: String(fd.get("password") || ""),
        });
        location.reload();
      } catch (err) {
        $("auth-msg").className = "msg err";
        $("auth-msg").textContent = (mode === "login" ? "登录失败：" : "注册失败：") + API.esc(err.message);
      }
    });
    $("auth-register").addEventListener("click", () => {
      mode = mode === "login" ? "register" : "login";
      $("auth-login").textContent = mode === "login" ? "登录" : "注册并登录";
      $("auth-register").textContent = mode === "login" ? "注册新账户" : "改为登录";
    });
    $("my-posts").innerHTML = '<p class="muted">登录后可管理内容</p>';
    $("ledger").innerHTML = "";
    $("orders").innerHTML = "";
  }

  async function loadAccount() {
    $("account-info").innerHTML = `
      <p>用户名：<b>${API.esc(me.user.username)}</b> <span class="tag">${me.user.role === "admin" ? "管理员" : "用户"}</span></p>
      <p>余额：<b>${me.user.balance}</b> 积分</p>
    `;
    const link = `${location.origin}/?ref=${encodeURIComponent(me.user.inviteCode)}`;
    $("invite-link").textContent = link;
    $("invite-stats").textContent =
      `有效邀请访问 ${me.invite.visits} 次，累计获得 ${me.invite.earned} 积分。` +
      `新访客通过该链接访问时，你将获得邀请奖励（每 IP 一次，有每日上限）。`;
  }

  async function loadMyPosts() {
    try {
      const data = await API.get("/api/me/posts");
      const box = $("my-posts");
      if (!data.items.length) {
        box.innerHTML = '<p class="muted">还没有发布内容。到 <a href="/">像素墙</a> 选择一块区域吧。</p>';
        return;
      }
      box.innerHTML = "";
      for (const p of data.items) {
        const item = document.createElement("div");
        item.className = "post-item";
        const statusTag =
          p.status === "active" ? '<span class="tag ok">生效中</span>'
          : p.status === "expired" ? '<span class="tag err">已过期</span>'
          : '<span class="tag warn">已删除</span>';
        item.innerHTML = `
          <div class="row">
            ${statusTag}
            <span class="muted">(${p.x}, ${p.y}) ${p.width}×${p.height} · 发布费率 P=${p.priceP} D=${p.priceD}</span>
            ${p.status === "active" ? `<span class="muted">下次日结 ${API.esc(p.nextBillingDate)}</span>` : ""}
          </div>
          <div class="row">
            <span style="flex:1">${p.text ? API.esc(p.text) : '<span class="muted">（图片内容）</span>'}</span>
            ${p.link ? `<a href="${API.esc(API.safeLink(p.link) || "#")}" target="_blank" rel="noopener noreferrer">链接 ↗</a>` : ""}
          </div>
        `;
        if (p.status === "active") {
          const actions = document.createElement("div");
          actions.className = "row";
          const editBtn = document.createElement("button");
          editBtn.textContent = "编辑内容";
          editBtn.addEventListener("click", () => editPost(p));
          const delBtn = document.createElement("button");
          delBtn.textContent = "删除（不退款）";
          delBtn.addEventListener("click", () => deletePost(p));
          actions.appendChild(editBtn);
          actions.appendChild(delBtn);
          item.appendChild(actions);
        }
        box.appendChild(item);
      }
    } catch (e) {
      $("my-posts").innerHTML = `<p class="msg err">加载失败：${API.esc(e.message)}</p>`;
    }
  }

  function editPost(p) {
    const text = prompt("修改文字（留空且无图片将被拒绝）：", p.text || "");
    if (text === null) return;
    const link = prompt("修改链接（http/https，可留空）：", p.link || "") ?? "";
    API.patch(`/api/posts/${encodeURIComponent(p.id)}`, { text, link })
      .then(() => loadMyPosts())
      .catch((e) => alert("编辑失败：" + e.message));
  }

  function deletePost(p) {
    if (!confirm(`确定删除 (${p.x}, ${p.y}) ${p.width}×${p.height} 的内容？已扣费用不退回，位置将立即释放。`)) return;
    API.del(`/api/posts/${encodeURIComponent(p.id)}`)
      .then(() => loadMyPosts())
      .catch((e) => alert("删除失败：" + e.message));
  }

  let ledgerPage = 1;
  async function loadLedger() {
    try {
      const data = await API.get(`/api/me/ledger?page=${ledgerPage}`);
      const box = $("ledger");
      if (ledgerPage === 1) box.innerHTML = "";
      for (const l of data.items) {
        const div = document.createElement("div");
        div.className = "ledger-item";
        const reasonText = {
          register: "注册奖励", invite: "邀请奖励", donation: "捐助确认",
          publish: "发布扣费", daily: "每日占用费", bulk: "管理员赠送",
        }[l.reason] || l.reason;
        div.innerHTML = `
          <span class="${l.amount > 0 ? "amount-pos" : "amount-neg"}">${l.amount > 0 ? "+" : ""}${l.amount}</span>
          <span>${reasonText}</span>
          <span class="muted">余额 ${l.balanceAfter} · ${API.fmtTime(l.createdAt)}</span>
        `;
        box.appendChild(div);
      }
      $("btn-ledger-more").hidden = ledgerPage * data.size >= data.total;
    } catch (e) {
      $("ledger").innerHTML = `<p class="msg err">加载失败：${API.esc(e.message)}</p>`;
    }
  }

  async function loadOrders() {
    try {
      const data = await API.get("/api/me/orders");
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
          <span class="num">${(o.amountFen / 100).toFixed(2)} 元 → ${o.points} 积分</span>
          <span class="muted">兑换率 ${o.rateSnapshot}/元 · ${API.fmtTime(o.createdAt)}</span>
        `;
        if (o.status === "pending") {
          const btn = document.createElement("button");
          btn.textContent = "取消订单";
          btn.addEventListener("click", async () => {
            try {
              await API.post(`/api/me/orders/${encodeURIComponent(o.id)}/cancel`);
              loadOrders();
            } catch (e) { alert("取消失败：" + e.message); }
          });
          div.appendChild(btn);
        }
        box.appendChild(div);
      }
    } catch (e) {
      $("orders").innerHTML = `<p class="msg err">加载失败：${API.esc(e.message)}</p>`;
    }
  }

  function bindEvents() {
    $("btn-logout").addEventListener("click", async () => {
      try { await API.post("/api/auth/logout"); } catch (_) {}
      location.href = "/";
    });
    $("btn-ledger-more").addEventListener("click", () => { ledgerPage++; loadLedger(); });
    $("donate-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const yuan = Number($("donate-yuan").value);
      if (!Number.isFinite(yuan) || yuan <= 0) return;
      const fen = Math.round(yuan * 100);
      try {
        const data = await API.post("/api/me/orders", { amountFen: fen });
        alert(`订单已创建：${(fen / 100).toFixed(2)} 元 → ${data.order.points} 积分。\n请通过公示渠道转账，管理员确认到账后入账。`);
        $("donate-yuan").value = "";
        loadOrders();
      } catch (err) {
        alert("创建失败：" + err.message);
      }
    });
  }

  init();
})();
