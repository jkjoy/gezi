/* 用户后台：登录态切换、账户、我的内容（编辑/删除）、流水、捐助订单 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const icon = (name, size) => (window.Icons ? Icons.svg(name, { size: size || 16 }) : "");
  let me = null;

  async function init() {
    try {
      me = await API.get("/api/auth/me");
    } catch (_) {
      /* 未登录或网络异常 */
    }
    if (!me || !me.user) {
      showAuth();
      return;
    }
    // 已登录：隐藏登录卡，显示内容
    $("auth-page").hidden = true;
    $("app-content").hidden = false;
    $("btn-logout").hidden = false;
    const roleTag = me.user.role === "admin"
      ? `<span class="tag ok">${icon("shield-check")} 管理员</span>`
      : "";
    $("user-badge").innerHTML = `${icon("user-circle")} ${API.esc(me.user.username)} ${roleTag} · ${me.user.balance} 积分`;
    bindApp();
    loadAccount();
    loadMyPosts();
    loadLedger();
    loadOrders();
  }

  // ---- 未登录：登录 / 注册 ----
  function showAuth() {
    $("auth-page").hidden = false;
    $("app-content").hidden = true;
    $("btn-logout").hidden = true;
    let mode = "login";
    const form = $("auth-form");
    const submit = $("auth-submit");
    const toggle = $("auth-toggle");
    const title = $("auth-title");

    toggle.addEventListener("click", () => {
      mode = mode === "login" ? "register" : "login";
      title.textContent = mode === "login" ? "登录" : "注册";
      submit.textContent = mode === "login" ? "登录" : "注册并登录";
      toggle.textContent = mode === "login" ? "没有账户？注册" : "已有账户？登录";
      $("auth-msg").textContent = "";
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      submit.disabled = true;
      try {
        const resp = await API.post(`/api/auth/${mode}`, {
          username: String(fd.get("username") || ""),
          password: String(fd.get("password") || ""),
        });
        if (resp.message) {
          // 管理员提示先亮出来再刷新，用户能看到身份说明
          $("auth-msg").className = "msg ok";
          $("auth-msg").textContent = resp.message;
          await new Promise((r) => setTimeout(r, 1800));
        }
        location.reload();
      } catch (err) {
        $("auth-msg").className = "msg err";
        $("auth-msg").textContent = (mode === "login" ? "登录失败：" : "注册失败：") + API.esc(err.message);
        submit.disabled = false;
      }
    });
  }

  // ---- 已登录：账户 ----
  function loadAccount() {
    const roleTag = me.user.role === "admin"
      ? `<span class="tag">${icon("shield-check", 14)} 管理员</span>`
      : `<span class="tag">用户</span>`;
    $("account-info").innerHTML = `
      <p>用户名：<b>${API.esc(me.user.username)}</b> ${roleTag}</p>
      <p class="balance">${icon("wallet", 18)} 余额 <b>${me.user.balance}</b> 积分</p>
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
          p.status === "active" ? `<span class="tag ok">${icon("check-circle", 14)} 生效中</span>`
          : p.status === "expired" ? `<span class="tag err">${icon("x-circle", 14)} 已过期</span>`
          : `<span class="tag warn">${icon("trash", 14)} 已删除</span>`;
        item.innerHTML = `
          <div class="row">
            ${statusTag}
            <span class="muted">(${p.x}, ${p.y}) ${p.width}×${p.height} · 费率 P=${p.priceP} D=${p.priceD}</span>
            ${p.status === "active" ? `<span class="muted">下次日结 ${API.esc(p.nextBillingDate)}</span>` : ""}
          </div>
          <div class="row">
            <span style="flex:1">${p.text ? API.esc(p.text) : '<span class="muted">（图片内容）</span>'}</span>
            ${p.link ? `<a href="${API.esc(API.safeLink(p.link) || "#")}" target="_blank" rel="noopener noreferrer">${icon("arrow-square-out", 14)} 链接</a>` : ""}
          </div>
        `;
        if (p.status === "active") {
          const actions = document.createElement("div");
          actions.className = "row";
          const editBtn = document.createElement("button");
          editBtn.innerHTML = `${icon("pencil-simple", 14)} 编辑内容`;
          editBtn.addEventListener("click", () => editPost(p));
          const delBtn = document.createElement("button");
          delBtn.innerHTML = `${icon("trash", 14)} 删除（不退款）`;
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

  const REASON = {
    register: ["gift", "注册奖励"], invite: ["users-three", "邀请奖励"],
    donation: ["hand-heart", "捐助确认"], publish: ["image-square", "发布扣费"],
    daily: ["clock-counter-clockwise", "每日占用费"], bulk: ["gift", "管理员赠送"],
  };

  let ledgerPage = 1;
  async function loadLedger() {
    try {
      const data = await API.get(`/api/me/ledger?page=${ledgerPage}`);
      const box = $("ledger");
      if (ledgerPage === 1) box.innerHTML = "";
      for (const l of data.items) {
        const div = document.createElement("div");
        div.className = "ledger-item";
        const [ic, label] = REASON[l.reason] || ["receipt", l.reason];
        div.innerHTML = `
          <span class="reason">${icon(ic, 15)} ${label}</span>
          <span class="${l.amount > 0 ? "amount-pos" : "amount-neg"}">${l.amount > 0 ? "+" : ""}${l.amount}</span>
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
          o.status === "pending" ? `<span class="tag warn">${icon("warning-circle", 14)} 待确认</span>`
          : o.status === "confirmed" ? `<span class="tag ok">${icon("check-circle", 14)} 已确认</span>`
          : `<span class="tag err">${icon("x-circle", 14)} 已取消</span>`;
        div.innerHTML = `
          ${statusTag}
          <span class="num">${(o.amountFen / 100).toFixed(2)} 元 → ${o.points} 积分</span>
          <span class="muted">兑换率 ${o.rateSnapshot}/元 · ${API.fmtTime(o.createdAt)}</span>
        `;
        if (o.status === "pending") {
          const btn = document.createElement("button");
          btn.innerHTML = `${icon("x", 14)} 取消订单`;
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

  function bindApp() {
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
