/* 管理员后台：配置、用户搜索、批量赠送、捐助确认、日结与清理、审计日志 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const icon = (name, size) => (window.Icons ? Icons.svg(name, { size: size || 14 }) : "");

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
      document.body.innerHTML = '<div class="p-10 text-center">需要管理员权限，请先 <a href="/dashboard.html">登录</a>。</div>';
      return;
    }
    $("user-badge").textContent = `${me.user.username} · 管理员`;
    bindEvents();

    // 按标签懒加载：先挂监听再 init，否则首个标签的 tab:show 会漏掉
    const list = document.querySelector('[role="tablist"]');
    list.addEventListener("tab:show", (e) => {
      if (e.detail.id === "panel-settings") loadSettings();
      else if (e.detail.id === "panel-users") loadUsers();
      else if (e.detail.id === "panel-orders") loadOrders();
      else if (e.detail.id === "panel-audit") loadAudit();
      // panel-bulk / panel-ops 是纯操作面板，无需预取数据
    });
    Tabs.init(list);
  }

  async function loadSettings() {
    try {
      const s = (await API.get("/api/admin/settings")).settings;
      const form = $("settings-form");
      form.innerHTML = "";
      for (const [key, label, min, max] of SETTING_FIELDS) {
        const row = document.createElement("label");
        row.className = "mb-2.5 block text-[13px] text-muted";
        row.innerHTML = `${label} <input type="number" name="${key}" value="${s[key]}" min="${min}" max="${max}" class="mt-1">`;
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
      let html = '<table class="data-table"><tr><th>用户名</th><th>角色</th><th>余额</th><th>注册时间</th><th>用户 ID</th></tr>';
      for (const u of data.items) {
        html += `<tr>
          <td>${API.esc(u.username)}</td>
          <td>${u.role === "admin" ? '<span class="tag">admin</span>' : ""}</td>
          <td class="num">${u.balance}</td>
          <td class="text-muted">${API.fmtTime(u.createdAt)}</td>
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
        div.className = "border-b border-line py-2.5 text-sm last:border-b-0 flex flex-wrap items-center gap-2.5";
        const statusTag =
          o.status === "pending" ? `<span class="tag warn">${icon("warning-circle")} 待确认</span>`
          : o.status === "confirmed" ? `<span class="tag ok">${icon("check-circle")} 已确认</span>`
          : `<span class="tag err">${icon("x-circle")} 已取消</span>`;
        div.innerHTML = `
          ${statusTag}
          <b>${API.esc(o.username)}</b>
          <span class="[font-variant-numeric:tabular-nums]">${(o.amountFen / 100).toFixed(2)} 元 → ${o.points} 积分</span>
          <span class="muted">快照 ${o.rateSnapshot}/元 · ${API.fmtTime(o.createdAt)}</span>
          ${o.txnNo ? `<span class="muted">已确认：${API.esc(o.channel || "")} ${API.esc(o.txnNo)}</span>` : ""}
        `;
        if (o.status === "pending") {
          const btn = document.createElement("button");
          btn.className = "btn";
          btn.innerHTML = `${icon("check-circle")} 确认到账`;
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
    Modal.open({
      title: "确认到账",
      icon: "hand-heart",
      confirmText: "确认入账",
      render(body) {
        body.innerHTML =
          `<p class="mb-3 text-sm leading-relaxed">${API.esc(o.username)} 的捐助订单 ` +
          `<b>${(o.amountFen / 100).toFixed(2)} 元</b>，确认后入账 <b>${o.points}</b> 积分。</p>` +
          '<label class="mb-3 block text-[13px] text-muted">收款渠道' +
          '<input id="cf-channel" type="text" maxlength="32" placeholder="wx / alipay / bank" class="mt-1.5"></label>' +
          '<label class="mb-3 block text-[13px] text-muted">到账交易号' +
          '<input id="cf-txn" type="text" maxlength="128" class="mt-1.5"></label>' +
          '<p class="mt-1.5 text-xs text-muted">同一渠道的同一交易号只能关联一个订单。</p>';
        body.querySelector("#cf-channel").value = "wx";
        return () => {
          const channel = body.querySelector("#cf-channel").value.trim();
          const txnNo = body.querySelector("#cf-txn").value.trim();
          // 抛错由模态内的错误行显示，不关闭窗口
          if (!channel) throw new Error("请填写收款渠道");
          if (!txnNo) throw new Error("请填写到账交易号");
          return { channel, txnNo };
        };
      },
      async onConfirm(v) {
        const r = await API.post(
          `/api/admin/donation-orders/${encodeURIComponent(o.id)}/confirm`,
          v
        );
        loadOrders();
        // 幂等命中时必须让管理员知道没有重复入账
        if (r.already) {
          Modal.alert({
            title: "订单此前已确认",
            icon: "warning-circle",
            message: "该订单之前已经确认过，本次未重复入账。",
          });
        }
      },
    });
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
        div.className = "border-b border-line py-2.5 text-sm last:border-b-0 flex flex-wrap items-center gap-2.5";
        div.innerHTML = `<code>${API.esc(a.action)}</code> <span class="muted">${API.esc(a.objectType || "")} ${API.esc(a.objectId || "")} · ${API.fmtTime(a.createdAt)}</span>`;
        box.appendChild(div);
      }
      $("btn-audit-more").hidden = auditPage * data.size >= data.total;
    } catch (e) {
      $("audit").innerHTML = `<p class="msg err">加载失败：${API.esc(e.message)}</p>`;
    }
  }

  // ---- 批量赠送：按条件筛选发放对象 ----

  /** 读取筛选表单；空值一律不进 filter，交给后端按“未设置”处理 */
  function readBulkFilter() {
    const v = (id) => $(id).value.trim();
    const f = {};
    const role = v("bulk-role");
    if (role && role !== "all") f.role = role;
    const bMin = v("bulk-balance-min");
    if (bMin !== "") f.balanceMin = Number(bMin);
    const bMax = v("bulk-balance-max");
    if (bMax !== "") f.balanceMax = Number(bMax);
    const from = v("bulk-created-from");
    if (from) f.createdFrom = from;
    const to = v("bulk-created-to");
    if (to) f.createdTo = to;
    const q = v("bulk-q");
    if (q) f.q = q;
    return f;
  }

  /** 条件的中文描述，用于确认弹窗里回显“这批分是发给谁的” */
  function describeFilter(f) {
    const parts = [];
    if (f.role) parts.push(f.role === "admin" ? "仅管理员" : "仅普通用户");
    if (f.balanceMin !== undefined) parts.push(`余额 ≥ ${f.balanceMin}`);
    if (f.balanceMax !== undefined) parts.push(`余额 ≤ ${f.balanceMax}`);
    if (f.createdFrom) parts.push(`注册日期 ≥ ${f.createdFrom}`);
    if (f.createdTo) parts.push(`注册日期 ≤ ${f.createdTo}`);
    if (f.q) parts.push(`用户名含「${f.q}」`);
    return parts.length ? "条件：" + parts.join("，") : "";
  }

  /** 预览命中用户。返回 null 表示条件不合法或查询失败，调用方应中止发放 */
  async function previewBulk() {
    const box = $("bulk-preview");
    const filter = readBulkFilter();
    if (!Object.keys(filter).length) {
      box.innerHTML = '<p class="msg err">请至少设置一个筛选条件</p>';
      return null;
    }
    box.innerHTML = '<p class="muted">查询中…</p>';
    try {
      const r = await API.post("/api/admin/users/preview", filter);
      renderPreview(r);
      return r;
    } catch (e) {
      box.innerHTML = `<p class="msg err">查询失败：${API.esc(e.message)}</p>`;
      return null;
    }
  }

  function renderPreview(r) {
    const head = r.exceedsLimit
      ? `<p class="msg err">匹配 <b>${r.count}</b> 人，超过单批上限 ${r.limit} 人，无法发放，请缩小条件范围。</p>`
      : `<p class="msg ok">匹配到 <b>${r.count}</b> 人` +
        (r.count > r.sample.length ? `（下表仅显示前 ${r.sample.length} 人）` : "") + "。</p>";
    const rows = r.sample.map((u) => `<tr>
        <td>${API.esc(u.username)}</td>
        <td>${u.role === "admin" ? '<span class="tag">admin</span>' : ""}</td>
        <td class="num">${u.balance}</td>
        <td class="text-muted">${API.fmtTime(u.createdAt)}</td>
      </tr>`).join("");
    const table = r.sample.length
      ? `<div class="overflow-x-auto"><table class="data-table">
           <tr><th>用户名</th><th>角色</th><th>余额</th><th>注册时间</th></tr>${rows}
         </table></div>`
      : "";
    $("bulk-preview").innerHTML = head + table;
  }

  async function onBulkSubmit(e) {
    e.preventDefault();
    const filter = readBulkFilter();
    const amount = Math.trunc(Number($("bulk-amount").value) || 0);
    const reason = $("bulk-reason").value.trim();
    if (!Object.keys(filter).length) {
      $("bulk-result").innerHTML = '<p class="msg err">请至少设置一个筛选条件</p>';
      return;
    }
    if (amount <= 0) return;

    // 发放前按当前条件重新预览，让管理员在确认框里看到准确人数与总量。
    // 真正发放时后端会用同一条件再解析一次，两者一致。
    const preview = await previewBulk();
    if (!preview || preview.exceedsLimit) return;

    Modal.open({
      title: "确认批量赠送",
      icon: "gift",
      confirmText: "确认发放",
      render(body) {
        const box = document.createElement("div");
        box.className = "text-sm leading-relaxed";
        box.textContent =
          `将向筛选出的 ${preview.count} 名用户各发放 ${amount} 积分，` +
          `合计 ${preview.count * amount} 积分。\n` +
          `${describeFilter(filter)}\n原因：${reason}`;
        body.appendChild(box);
        return () => true;
      },
      async onConfirm() {
        const r = await API.post("/api/admin/bulk-grants", { filter, amount, reason });
        $("bulk-result").innerHTML =
          `<p class="msg ok">批次 ${API.esc(r.batchId)}：匹配 ${r.matched} 人，` +
          `成功 ${r.succeeded}，失败 ${r.failed}，剩余 ${r.remaining}。</p>`;
        // 标签页只在首次显示时懒加载，已看过的用户页余额会过期，这里主动刷新
        loadUsers($("user-q").value.trim());
        previewBulk();
      },
    });
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
    $("btn-bulk-preview").addEventListener("click", () => previewBulk());
    $("bulk-form").addEventListener("submit", onBulkSubmit);
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
