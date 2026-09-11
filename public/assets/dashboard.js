/* 用户后台：登录态切换、账户、我的内容（编辑/删除）、流水、捐助订单 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const icon = (name, size) => (window.Icons ? Icons.svg(name, { size: size || 16 }) : "");
  let me = null;

  // 列表项与行的 Tailwind 组合。写成字面量常量，Tailwind 扫描源码时仍能识别，
  // 同时避免在每个模板里重复一长串 utility。
  const ITEM = "border-b border-line py-2.5 text-sm last:border-b-0";
  const ROW = "flex flex-wrap items-center gap-2.5";
  const NUM = "[font-variant-numeric:tabular-nums]";

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
    // 已登录：隐藏登录卡，显示标签栏与内容
    $("auth-page").hidden = true;
    $("app-content").hidden = false;
    $("tabbar").hidden = false;
    $("btn-logout").hidden = false;
    const roleTag = me.user.role === "admin"
      ? `<span class="tag ok">${icon("shield-check")} 管理员</span>`
      : "";
    $("user-badge").innerHTML = `${icon("user-circle")} ${API.esc(me.user.username)} ${roleTag} · ${me.user.balance} 积分`;
    bindApp();

    // 按标签懒加载：先挂监听再 init，否则首个标签的 tab:show 会漏掉
    const list = document.querySelector('[role="tablist"]');
    list.addEventListener("tab:show", (e) => {
      if (e.detail.id === "panel-account") loadAccount();
      else if (e.detail.id === "panel-posts") loadMyPosts();
      else if (e.detail.id === "panel-ledger") loadLedger();
      else if (e.detail.id === "panel-donate") loadOrders();
    });
    Tabs.init(list);
  }

  // ---- 未登录：登录 / 注册 ----
  function showAuth() {
    $("auth-page").hidden = false;
    $("app-content").hidden = true;
    $("tabbar").hidden = true;
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

    const recoverBtn = $("auth-recover");
    recoverBtn.addEventListener("click", showRecoverModal);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      submit.disabled = true;
      try {
        const resp = await API.post(`/api/auth/${mode}`, {
          username: String(fd.get("username") || ""),
          password: String(fd.get("password") || ""),
        });
        if (mode === "register" && resp.recoveryCode) {
          // 恢复码只显示这一次：禁用表单、展示恢复码，等用户确认已保存再进入。
          // 不自动刷新——1.8 秒不够抄录一组恢复码。
          for (const el of form.querySelectorAll("input")) el.disabled = true;
          const msg = $("auth-msg");
          msg.className = "msg ok";
          msg.innerHTML = `
            <p class="mb-2">${API.esc(resp.message)}</p>
            <div class="rounded-md border border-accent bg-panel-2 px-3 py-2 text-center">
              <div class="mb-1 text-xs text-muted">恢复码（仅此一次展示，请抄录保存）</div>
              <code class="text-sm tracking-wider">${API.esc(resp.recoveryCode)}</code>
            </div>`;
          const done = document.createElement("button");
          done.type = "button";
          done.className = "btn btn-primary mt-3";
          done.textContent = "我已保存，进入后台";
          done.addEventListener("click", () => location.reload());
          msg.appendChild(done);
          return; // 不自动刷新
        }
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

  // ---- 未登录：忘记密码（恢复码重置） ----
  function showRecoverModal() {
    Modal.open({
      title: "找回密码",
      icon: "shield-check",
      confirmText: "重置密码",
      render(body) {
        body.innerHTML =
          '<label class="mb-3 block text-[13px] text-muted">用户名' +
          '<input id="rec-username" autocomplete="username" maxlength="24" class="mt-1.5"></label>' +
          '<label class="mb-3 block text-[13px] text-muted">恢复码' +
          '<input id="rec-code" maxlength="64" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" class="mt-1.5"></label>' +
          '<label class="mb-3 block text-[13px] text-muted">新密码（至少 8 位）' +
          '<input id="rec-pass" type="password" autocomplete="new-password" maxlength="64" class="mt-1.5"></label>' +
          '<label class="mb-3 block text-[13px] text-muted">确认新密码' +
          '<input id="rec-pass2" type="password" autocomplete="new-password" maxlength="64" class="mt-1.5"></label>' +
          '<p class="mt-1.5 text-xs text-muted">恢复码在注册或重新生成时显示，仅出现一次。</p>';
        body.querySelector("#rec-username").focus();
        return () => {
          const username = body.querySelector("#rec-username").value.trim();
          const recoveryCode = body.querySelector("#rec-code").value.trim();
          const p1 = body.querySelector("#rec-pass").value;
          const p2 = body.querySelector("#rec-pass2").value;
          if (!username) throw new Error("请填写用户名");
          if (!recoveryCode) throw new Error("请填写恢复码");
          if (p1.length < 8) throw new Error("新密码至少 8 位");
          if (p1 !== p2) throw new Error("两次输入的密码不一致");
          return { username, recoveryCode, newPassword: p1 };
        };
      },
      async onConfirm(v) {
        // 服务端会轮换恢复码并返回新码，必须展示，否则下次忘记密码就彻底进不去
        const r = await API.post("/api/auth/recover", v);
        Modal.alert({
          title: "密码已重置",
          icon: "shield-check",
          message:
            "请用新密码登录。\n\n新恢复码（仅此一次展示，请保存）：\n" + r.recoveryCode,
        });
      },
    });
  }

  // ---- 已登录：账户 ----
  function loadAccount() {
    const roleTag = me.user.role === "admin"
      ? `<span class="tag">${icon("shield-check", 14)} 管理员</span>`
      : `<span class="tag">用户</span>`;
    $("account-info").innerHTML = `
      <p>用户名：<b>${API.esc(me.user.username)}</b> ${roleTag}</p>
      <p class="flex items-center gap-2">${icon("wallet", 18)} 余额 <b>${me.user.balance}</b> 积分</p>
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
        item.className = ITEM;
        const statusTag =
          p.status === "active" ? `<span class="tag ok">${icon("check-circle", 14)} 生效中</span>`
          : p.status === "expired" ? `<span class="tag err">${icon("x-circle", 14)} 已过期</span>`
          : `<span class="tag warn">${icon("trash", 14)} 已删除</span>`;
        item.innerHTML = `
          <div class="${ROW}">
            ${statusTag}
            <span class="muted">(${p.x}, ${p.y}) ${p.width}×${p.height} · 费率 P=${p.priceP} D=${p.priceD}</span>
            ${p.status === "active" ? `<span class="muted">下次日结 ${API.esc(p.nextBillingDate)}</span>` : ""}
          </div>
          <div class="${ROW}">
            <span class="min-w-0 flex-1">${p.text ? API.esc(p.text) : '<span class="muted">（图片内容）</span>'}</span>
            ${p.link ? `<a href="${API.esc(API.safeLink(p.link) || "#")}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5">${icon("arrow-square-out", 14)} 链接</a>` : ""}
          </div>
        `;
        if (p.status === "active") {
          const actions = document.createElement("div");
          actions.className = ROW + " mt-2";
          const editBtn = document.createElement("button");
          editBtn.className = "btn";
          editBtn.innerHTML = `${icon("pencil-simple", 14)} 编辑内容`;
          editBtn.addEventListener("click", () => editPost(p));
          const delBtn = document.createElement("button");
          delBtn.className = "btn";
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
    Modal.open({
      title: "编辑内容",
      icon: "pencil-simple",
      confirmText: "保存",
      render(body) {
        body.innerHTML =
          '<label class="mb-3 block text-[13px] text-muted">文字（留空且无图片将被拒绝）' +
          `<textarea id="edit-text" rows="3" maxlength="500" class="mt-1.5"></textarea></label>` +
          '<label class="mb-3 block text-[13px] text-muted">链接（http/https，可留空）' +
          `<input id="edit-link" type="url" maxlength="300" placeholder="https://example.com" class="mt-1.5"></label>` +
          `<p class="mt-1.5 text-xs text-muted">位置 (${p.x}, ${p.y}) ${p.width}×${p.height}，尺寸与位置不可修改。</p>`;
        // 用 value 赋值而非拼进 HTML，避免把用户内容当标记解析
        body.querySelector("#edit-text").value = p.text || "";
        body.querySelector("#edit-link").value = p.link || "";
        return () => ({
          text: body.querySelector("#edit-text").value,
          link: body.querySelector("#edit-link").value.trim(),
        });
      },
      async onConfirm(v) {
        // 抛错会显示在模态内的错误行且不关闭，不需要再弹一层
        await API.patch(`/api/posts/${encodeURIComponent(p.id)}`, v);
        loadMyPosts();
      },
    });
  }

  function deletePost(p) {
    Modal.open({
      title: "删除内容",
      icon: "trash",
      danger: true,
      confirmText: "删除",
      render(body) {
        const el = document.createElement("p");
        el.className = "my-1 text-sm leading-relaxed";
        el.textContent =
          `确定删除 (${p.x}, ${p.y}) ${p.width}×${p.height} 的内容？` +
          "已扣费用不退回，位置将立即释放给他人。";
        body.appendChild(el);
        return () => true;
      },
      async onConfirm() {
        await API.del(`/api/posts/${encodeURIComponent(p.id)}`);
        loadMyPosts();
      },
    });
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
        div.className = ITEM + " " + ROW;
        const [ic, label] = REASON[l.reason] || ["receipt", l.reason];
        div.innerHTML = `
          <span class="inline-flex min-w-[130px] items-center gap-1.5">${icon(ic, 15)} ${label}</span>
          <span class="${l.amount > 0 ? "text-ok" : "text-err"}">${l.amount > 0 ? "+" : ""}${l.amount}</span>
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
        div.className = ITEM + " " + ROW;
        const statusTag =
          o.status === "pending" ? `<span class="tag warn">${icon("warning-circle", 14)} 待确认</span>`
          : o.status === "confirmed" ? `<span class="tag ok">${icon("check-circle", 14)} 已确认</span>`
          : `<span class="tag err">${icon("x-circle", 14)} 已取消</span>`;
        div.innerHTML = `
          ${statusTag}
          <span class="${NUM}">${(o.amountFen / 100).toFixed(2)} 元 → ${o.points} 积分</span>
          <span class="muted">兑换率 ${o.rateSnapshot}/元 · ${API.fmtTime(o.createdAt)}</span>
        `;
        if (o.status === "pending") {
          const btn = document.createElement("button");
          btn.className = "btn";
          btn.innerHTML = `${icon("x", 14)} 取消订单`;
          btn.addEventListener("click", () => {
            Modal.open({
              title: "取消订单",
              icon: "x-circle",
              danger: true,
              confirmText: "取消订单",
              cancelText: "返回",
              render(body) {
                const el = document.createElement("p");
                el.className = "my-1 text-sm leading-relaxed";
                el.textContent = `确定取消 ${(o.amountFen / 100).toFixed(2)} 元的捐助订单？取消后该订单不再可确认到账。`;
                body.appendChild(el);
                return () => true;
              },
              async onConfirm() {
                await API.post(`/api/me/orders/${encodeURIComponent(o.id)}/cancel`);
                loadOrders();
              },
            });
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
    $("btn-change-password").addEventListener("click", showChangePasswordModal);
    $("btn-regen-recovery").addEventListener("click", showRegenRecoveryModal);
    $("donate-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const yuan = Number($("donate-yuan").value);
      if (!Number.isFinite(yuan) || yuan <= 0) return;
      const fen = Math.round(yuan * 100);
      try {
        const data = await API.post("/api/me/orders", { amountFen: fen });
        $("donate-yuan").value = "";
        loadOrders();
        Modal.alert({
          title: "订单已创建",
          icon: "hand-heart",
          message:
            `${(fen / 100).toFixed(2)} 元 → ${data.order.points} 积分。\n` +
            "请通过公示渠道转账，管理员确认到账后入账。",
        });
      } catch (err) {
        Modal.alert({ title: "创建失败", danger: true, message: err.message });
      }
    });
  }

  // ---- 已登录：修改密码（成功后强制重新登录） ----
  function showChangePasswordModal() {
    Modal.open({
      title: "修改密码",
      icon: "pencil-simple",
      confirmText: "修改并重新登录",
      render(body) {
        body.innerHTML =
          '<label class="mb-3 block text-[13px] text-muted">原密码' +
          '<input id="cp-old" type="password" autocomplete="current-password" maxlength="64" class="mt-1.5"></label>' +
          '<label class="mb-3 block text-[13px] text-muted">新密码（至少 8 位）' +
          '<input id="cp-new" type="password" autocomplete="new-password" maxlength="64" class="mt-1.5"></label>' +
          '<label class="mb-3 block text-[13px] text-muted">确认新密码' +
          '<input id="cp-new2" type="password" autocomplete="new-password" maxlength="64" class="mt-1.5"></label>' +
          '<p class="mt-1.5 text-xs text-muted">修改成功后所有登录会话都会失效，需要重新登录。</p>';
        body.querySelector("#cp-old").focus();
        return () => {
          const oldPassword = body.querySelector("#cp-old").value;
          const p1 = body.querySelector("#cp-new").value;
          const p2 = body.querySelector("#cp-new2").value;
          if (!oldPassword) throw new Error("请填写原密码");
          if (p1.length < 8) throw new Error("新密码至少 8 位");
          if (p1 !== p2) throw new Error("两次输入的新密码不一致");
          return { oldPassword, newPassword: p1 };
        };
      },
      async onConfirm(v) {
        await API.post("/api/me/password", v); // 服务端已清会话 Cookie
        await Modal.alert({
          title: "密码已修改",
          icon: "check-circle",
          message: "请用新密码重新登录。",
        });
        location.reload(); // Cookie 已清除，刷新后回到登录卡
      },
    });
  }

  // ---- 已登录：重新生成恢复码（旧码立即失效） ----
  function showRegenRecoveryModal() {
    Modal.open({
      title: "重新生成恢复码",
      icon: "shield-check",
      confirmText: "重新生成",
      render(body) {
        const el = document.createElement("p");
        el.className = "my-1 text-sm leading-relaxed";
        el.textContent = "将生成一组新的恢复码，旧的立即失效。新码只显示这一次，请妥善保存。";
        body.appendChild(el);
        return () => true;
      },
      async onConfirm() {
        const r = await API.post("/api/me/recovery-code");
        Modal.alert({
          title: "新恢复码已生成",
          icon: "shield-check",
          message: "请保存（仅此一次展示）：\n\n" + r.recoveryCode,
        });
      },
    });
  }

  init();
})();
