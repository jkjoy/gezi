/**
 * 邀请奖励、捐助订单、批量赠送与账本对账测试。
 */
import { beforeEach, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { getUserRow, initAdmin, jsonReq, ledgerSum, login, register } from "./helpers";

beforeEach(async () => {
  // 注意：不能只删管理员——“首个注册用户自动成为管理员”规则会让本文件
  // 第一个注册的用户（如 inv1）意外成为 admin，破坏各测试前提。
  // 因此先清空用户，再 initAdmin 建立明确的管理员，阻断自动提升路径。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("UPDATE system_settings SET value = '0' WHERE key = 'admin_initialized'"),
  ]);
  await initAdmin();
  // 默认邀请配置：奖励 20，每日上限 5
  await env.DB.batch([
    env.DB.prepare("UPDATE system_settings SET value = '20' WHERE key = 'invite_reward'"),
    env.DB.prepare("UPDATE system_settings SET value = '5' WHERE key = 'invite_daily_cap'"),
    env.DB.prepare("UPDATE system_settings SET value = '100' WHERE key = 'exchange_rate'"),
  ]);
});

function visitReq(code: string, ip = "203.0.113.10"): Promise<Response> {
  return SELF.fetch("http://localhost/api/invite/visit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, origin: "http://localhost" },
    body: JSON.stringify({ code }),
  });
}

it("邀请奖励：合格首访奖励一次，同 IP 重访不重复奖励", async () => {
  const inviter = await register("inv1");
  const first = await visitReq(inviter.user.inviteCode);
  expect(first.status).toBe(200);
  expect(((await first.json()) as { rewarded: boolean }).rewarded).toBe(true);
  expect((await getUserRow(inviter.user.id))!.balance).toBe(220);

  const second = await visitReq(inviter.user.inviteCode, "203.0.113.10");
  expect(((await second.json()) as { rewarded: boolean }).rewarded).toBe(false);
  expect((await getUserRow(inviter.user.id))!.balance).toBe(220);

  // 并发重访同一邀请码也只奖励一次
  const results = await Promise.all([
    visitReq(inviter.user.inviteCode, "198.51.100.7"),
    visitReq(inviter.user.inviteCode, "198.51.100.7"),
    visitReq(inviter.user.inviteCode, "198.51.100.7"),
  ]);
  const rewarded = (await Promise.all(results.map((r) => r.json() as Promise<{ rewarded: boolean }>))).filter(
    (r) => r.rewarded
  );
  expect(rewarded).toHaveLength(1);
  expect((await getUserRow(inviter.user.id))!.balance).toBe(240);
});

it("无效邀请码、自邀不奖励", async () => {
  const inviter = await register("inv2");
  const bad = await visitReq("NOPE1234");
  expect(((await bad.json()) as { rewarded: boolean }).rewarded).toBe(false);

  // 已登录邀请人访问自己的链接
  const self = await SELF.fetch("http://localhost/api/invite/visit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: inviter.cookie,
      "x-forwarded-for": "192.0.2.1",
      origin: "http://localhost",
    },
    body: JSON.stringify({ code: inviter.user.inviteCode }),
  });
  expect(((await self.json()) as { rewarded: boolean }).rewarded).toBe(false);
  expect((await getUserRow(inviter.user.id))!.balance).toBe(200);
});

it("每日奖励上限：超过 5 个不同 IP 后不再奖励", async () => {
  const inviter = await register("inv3");
  for (let i = 1; i <= 5; i++) {
    await visitReq(inviter.user.inviteCode, `198.51.100.${i}`);
  }
  expect((await getUserRow(inviter.user.id))!.balance).toBe(200 + 100);
  const sixth = await visitReq(inviter.user.inviteCode, "198.51.100.99");
  expect(((await sixth.json()) as { rewarded: boolean; reason?: string }).rewarded).toBe(false);
  expect((await getUserRow(inviter.user.id))!.balance).toBe(300);
});

it("捐助订单：下单不加分，确认后按快照入账一次", async () => {
  const user = await register("donor");
  const admin = await initAdmin();

  // 修改兑换率后再下单：下单时快照生效
  await env.DB.prepare("UPDATE system_settings SET value = '200' WHERE key = 'exchange_rate'").run();
  const created = await jsonReq("POST", "/api/me/orders", { amountFen: 5000 }, user.cookie);
  expect(created.status).toBe(200);
  const order = ((await created.json()) as { order: { id: string; points: number; rateSnapshot: number } }).order;
  expect(order.points).toBe(Math.floor((5000 * 200) / 100)); // floor(金额分 × R / 100)
  expect((await getUserRow(user.user.id))!.balance).toBe(200); // 下单不加分

  // 确认后费率变化不影响订单积分
  await env.DB.prepare("UPDATE system_settings SET value = '50' WHERE key = 'exchange_rate'").run();
  const confirmed = await jsonReq(
    "POST",
    `/api/admin/donation-orders/${order.id}/confirm`,
    { channel: "wx", txnNo: "TX-001" },
    admin.cookie
  );
  expect(confirmed.status).toBe(200);
  expect((await getUserRow(user.user.id))!.balance).toBe(200 + order.points);

  // 重复确认返回已有结果，不再次发放
  const again = await jsonReq(
    "POST",
    `/api/admin/donation-orders/${order.id}/confirm`,
    { channel: "wx", txnNo: "TX-001" },
    admin.cookie
  );
  expect(again.status).toBe(200);
  expect(((await again.json()) as { already: boolean }).already).toBe(true);
  expect((await getUserRow(user.user.id))!.balance).toBe(200 + order.points);
});

it("同一交易号跨订单重用被拒绝；取消订单不入账", async () => {
  const user = await register("donor2");
  const admin = await initAdmin();
  const o1 = ((await (await jsonReq("POST", "/api/me/orders", { amountFen: 1000 }, user.cookie)).json()) as {
    order: { id: string };
  }).order;
  const o2 = ((await (await jsonReq("POST", "/api/me/orders", { amountFen: 2000 }, user.cookie)).json()) as {
    order: { id: string };
  }).order;

  const c1 = await jsonReq("POST", `/api/admin/donation-orders/${o1.id}/confirm`, { channel: "alipay", txnNo: "SAME-TX" }, admin.cookie);
  expect(c1.status).toBe(200);
  const c2 = await jsonReq("POST", `/api/admin/donation-orders/${o2.id}/confirm`, { channel: "alipay", txnNo: "SAME-TX" }, admin.cookie);
  expect(c2.status).toBe(409);
  expect(((await c2.json()) as { error: string }).error).toBe("txn_used");

  // 取消已确认订单被拒绝
  const cancelConfirmed = await jsonReq("POST", `/api/me/orders/${o1.id}/cancel`, undefined, user.cookie);
  expect(cancelConfirmed.status).toBe(409);

  // 用户取消 pending 订单 → 不能再确认
  const cancel = await jsonReq("POST", `/api/me/orders/${o2.id}/cancel`, undefined, user.cookie);
  expect(cancel.status).toBe(200);
  const confirmCancelled = await jsonReq(
    "POST",
    `/api/admin/donation-orders/${o2.id}/confirm`,
    { channel: "alipay", txnNo: "OTHER-TX" },
    admin.cookie
  );
  expect(confirmCancelled.status).toBe(409);
  expect((await getUserRow(user.user.id))!.balance).toBe(200 + 1000); // 仅第一单入账
});

it("小额捐助被拒绝；负数与超大整数非法", async () => {
  const user = await register("donor3");
  const small = await jsonReq("POST", "/api/me/orders", { amountFen: 50 }, user.cookie); // 低于 100 分
  expect(small.status).toBe(400);
  const neg = await jsonReq("POST", "/api/me/orders", { amountFen: -100 }, user.cookie);
  expect(neg.status).toBe(400);
  const huge = await jsonReq("POST", "/api/me/orders", { amountFen: 1e12 }, user.cookie);
  expect(huge.status).toBe(400);
});

it("批量赠送：每用户只发一次，重试不重复", async () => {
  const admin = await initAdmin();
  const u1 = await register("grant1");
  const u2 = await register("grant2");

  const grant = await jsonReq(
    "POST",
    "/api/admin/bulk-grants",
    { userIds: [u1.user.id, u2.user.id], amount: 50, reason: "活动奖励" },
    admin.cookie
  );
  expect(grant.status).toBe(200);
  const g = (await grant.json()) as { batchId: string; succeeded: number };
  expect(g.succeeded).toBe(2);
  expect((await getUserRow(u1.user.id))!.balance).toBe(250);
  expect((await getUserRow(u2.user.id))!.balance).toBe(250);

  // 同批次重试：唯一键 (batch_id, user_id) 阻止重复赠送
  const retry = await jsonReq("POST", `/api/admin/bulk-grants/${g.batchId}/retry`, undefined, admin.cookie);
  expect(retry.status).toBe(200);
  expect((await getUserRow(u1.user.id))!.balance).toBe(250);

  // 批次内同一用户重复 ID 只发一次
  const dup = await jsonReq(
    "POST",
    "/api/admin/bulk-grants",
    { userIds: [u1.user.id, u1.user.id], amount: 10, reason: "重复 ID" },
    admin.cookie
  );
  expect(dup.status).toBe(200);
  expect((await getUserRow(u1.user.id))!.balance).toBe(260);
});

it("普通用户不能调用管理员接口", async () => {
  const user = await register("pleb");
  const res = await jsonReq("POST", "/api/admin/bulk-grants", { userIds: [user.user.id], amount: 999, reason: "x" }, user.cookie);
  expect(res.status).toBe(403);
  const res2 = await jsonReq("GET", "/api/admin/users", undefined, user.cookie);
  expect(res2.status).toBe(403);
});

it("账本对账：余额等于全部流水之和（含注册、邀请、捐助、批量）", async () => {
  const admin = await initAdmin();
  const inviter = await register("recon1");
  await visitReq(inviter.user.inviteCode, "203.0.113.77");

  const order = ((await (await jsonReq("POST", "/api/me/orders", { amountFen: 3000 }, inviter.cookie)).json()) as {
    order: { id: string; points: number };
  }).order;
  await jsonReq("POST", `/api/admin/donation-orders/${order.id}/confirm`, { channel: "bank", txnNo: "R-1" }, admin.cookie);
  await jsonReq(
    "POST",
    "/api/admin/bulk-grants",
    { userIds: [inviter.user.id], amount: 7, reason: "对账测试" },
    admin.cookie
  );

  const balance = (await getUserRow(inviter.user.id))!.balance;
  const sum = await ledgerSum(inviter.user.id);
  expect(balance).toBe(sum);

  // 后台账本可分页读取
  const ledger = (await (await jsonReq("GET", "/api/me/ledger", undefined, inviter.cookie)).json()) as {
    items: Array<{ amount: number; reason: string }>;
    total: number;
  };
  expect(ledger.total).toBe(4); // register + invite + donation + bulk
  expect(new Set(ledger.items.map((l) => l.reason))).toEqual(new Set(["register", "invite", "donation", "bulk"]));
});
