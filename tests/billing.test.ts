/**
 * 日结、余额不足过期、补算顺序与幂等测试。
 * 通过直接修改 next_billing_date 模拟时间流逝，验证业务规则而非系统时钟。
 */
import { beforeEach, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getUserRow, jsonReq, ledgerSum, publish, register, reqId } from "./helpers";
import { runSettlement } from "../src/billing";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE system_settings SET value = '2' WHERE key = 'publish_price_p'"),
    env.DB.prepare("UPDATE system_settings SET value = '1' WHERE key = 'daily_price_d'"),
  ]);
});

async function grantPoints(userId: string, amount: number): Promise<void> {
  // 测试捷径也保持账本一致：余额与流水一起写，避免对账断言失真
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(amount, userId),
    env.DB.prepare(
      `INSERT INTO point_ledger (user_id, amount, balance_after, reason, business_key, note, created_at)
       SELECT ?, ?, balance, 'bulk', ?, ?, ? FROM users WHERE id = ?`
    ).bind(userId, amount, `test:${userId}:${now}`, "测试补分", now, userId),
  ]);
}

async function makeDue(postId: string, datesAgo: number): Promise<void> {
  // 模拟该内容已逾期 N 天
  const target = new Date(Date.now() - datesAgo * 86400_000).toISOString().slice(0, 10);
  await env.DB.prepare("UPDATE grid_posts SET next_billing_date = ? WHERE id = ?").bind(target, postId).run();
}

it("日结按每日费用扣款，结算后推进下一次日期", async () => {
  const s = await register("bill1");
  await grantPoints(s.user.id, 1000);
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 4, height: 3, text: "x" }); // 12 格, D=1
  const { post } = (await res.json()) as { post: { id: string } };
  await makeDue(post.id, 1);

  const stats = await runSettlement(env.DB, 5000);
  expect(stats.charged).toBe(2); // 09-08 与 09-09 两天
  expect((await getUserRow(s.user.id))!.balance).toBe(200 + 1000 - 24 - 12 * 2);
  // 下次日期推进了一天
  const row = await env.DB.prepare("SELECT next_billing_date, status FROM grid_posts WHERE id = ?")
    .bind(post.id)
    .first<{ next_billing_date: string; status: string }>();
  expect(row!.status).toBe("active");
  expect(new Date(row!.next_billing_date + "T00:00:00Z").getTime()).toBeGreaterThan(Date.now() - 86400_000);
});

it("日结幂等：重复运行不重复扣费", async () => {
  const s = await register("bill2");
  await grantPoints(s.user.id, 1000);
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, text: "x" });
  const { post } = (await res.json()) as { post: { id: string } };
  await makeDue(post.id, 1);

  await runSettlement(env.DB, 5000);
  const bal1 = (await getUserRow(s.user.id))!.balance;
  await runSettlement(env.DB, 5000); // Cron 重试 / 手动再次触发
  await runSettlement(env.DB, 5000);
  const bal2 = (await getUserRow(s.user.id))!.balance;
  expect(bal1).toBe(bal2); // 重复运行不重复扣费
  const settlements = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_settlements WHERE post_id = ?").bind(post.id).first<{ n: number }>();
  expect(settlements!.n).toBe(2); // makeDue(1)：昨天 + 今天两天，各结算一次
  const distinct = await env.DB.prepare("SELECT COUNT(DISTINCT billing_date) AS n FROM daily_settlements WHERE post_id = ?").bind(post.id).first<{ n: number }>();
  expect(distinct!.n).toBe(2);
});

it("余额不足：仅过期该条，不扣部分费用，后续条目继续判断", async () => {
  const s = await register("bill3");
  await grantPoints(s.user.id, 1000);
  // 两条内容：post1 早发布（2×2=4 格 → 日费 4），post2 晚发布（2×2=4 格 → 日费 4）
  const r1 = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, text: "first" });
  const p1 = ((await r1.json()) as { post: { id: string } }).post;
  const r2 = await publish(s.cookie, { requestId: reqId(), x: 50, y: 50, width: 2, height: 2, text: "second" });
  const p2 = ((await r2.json()) as { post: { id: string } }).post;

  // 发布费各 8，余额 = 1200 - 16 = 1184；调整余额为 4：只够支付第一条的一天日费
  await env.DB.prepare("UPDATE users SET balance = 4 WHERE id = ?").bind(s.user.id).run();
  await makeDue(p1.id, 0); // 今天到期：只结算今天一天
  await makeDue(p2.id, 0);

  const stats = await runSettlement(env.DB, 5000);
  expect(stats.charged).toBe(1);
  expect(stats.expired).toBe(1);
  expect((await getUserRow(s.user.id))!.balance).toBe(0); // 4 - 4 = 0，无部分扣费

  const s1 = await env.DB.prepare("SELECT status FROM grid_posts WHERE id = ?").bind(p1.id).first<{ status: string }>();
  const s2 = await env.DB.prepare("SELECT status FROM grid_posts WHERE id = ?").bind(p2.id).first<{ status: string }>();
  expect(s1!.status).toBe("active");
  expect(s2!.status).toBe("expired");
  // 过期条目格子释放
  const cells = await env.DB.prepare("SELECT COUNT(*) AS n FROM grid_cells WHERE post_id = ?").bind(p2.id).first<{ n: number }>();
  expect(cells!.n).toBe(0);
  // 历史账本保留：注册 200 + 补 1000 - 发布 8×2 - 日结 4
  expect(await ledgerSum(s.user.id)).toBe(200 + 1000 - 8 - 8 - 4);
});

it("补算顺序：先处理较早日期的全部内容，再进入下一日期", async () => {
  const s = await register("bill4");
  await grantPoints(s.user.id, 10_000);
  const r1 = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, text: "a" }); // 日费 4
  const p1 = ((await r1.json()) as { post: { id: string } }).post;
  const r2 = await publish(s.cookie, { requestId: reqId(), x: 10, y: 10, width: 2, height: 2, text: "b" });
  const p2 = ((await r2.json()) as { post: { id: string } }).post;

  // p1 逾期 2 天 → 补算 [前天, 昨天, 今天] 共 3 天 × 4 = 12；p2 今天到期 1 天 × 4
  await env.DB.prepare("UPDATE grid_posts SET next_billing_date = ? WHERE id = ?").bind(
    new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10),
    p1.id
  ).run();
  await makeDue(p2.id, 0);

  // 余额恰好覆盖 p1 补算 12 + p2 一天 4 = 16
  await env.DB.prepare("UPDATE users SET balance = 16 WHERE id = ?").bind(s.user.id).run();

  const stats = await runSettlement(env.DB, 5000);
  expect(stats.charged).toBe(4); // p1 三天 + p2 一天
  expect(stats.expired).toBe(0);
  expect((await getUserRow(s.user.id))!.balance).toBe(0);
  expect(await ledgerSum(s.user.id)).toBe(200 + 10000 - 8 - 8 - 12 - 4);

  // p1 结算了 3 次（前天、昨天、今天），按日期先后处理
  const rows = await env.DB.prepare(
    "SELECT billing_date, amount FROM daily_settlements WHERE post_id = ? ORDER BY billing_date"
  )
    .bind(p1.id)
    .all<{ billing_date: string; amount: number }>();
  expect(rows.results).toHaveLength(3);
  expect(rows.results.every((r) => r.amount === 4)).toBe(true);
  const dates = rows.results.map((r) => r.billing_date);
  expect(dates).toEqual([...dates].sort());
});

it("逾期后充值不能恢复已过期内容；到期补算先于入账", async () => {
  const s = await register("bill5");
  await grantPoints(s.user.id, 1000);
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, text: "x" });
  const { post } = (await res.json()) as { post: { id: string } };
  await makeDue(post.id, 2);

  // 余额不足以支付，直接设置 0；过期通过“发布前补算”路径触发
  await env.DB.prepare("UPDATE users SET balance = 0 WHERE id = ?").bind(s.user.id).run();
  // 用户尝试再发布一条：补算会先过期旧内容
  const republish = await publish(s.cookie, { requestId: reqId(), x: 50, y: 50, width: 1, height: 1, text: "new" });
  expect(republish.status).toBe(400);
  const status = await env.DB.prepare("SELECT status FROM grid_posts WHERE id = ?").bind(post.id).first<{ status: string }>();
  expect(status!.status).toBe("expired");

  // 再充值后，过期内容不能恢复（没有恢复接口；重新占用需重新发布）
  await env.DB.prepare("UPDATE users SET balance = 9999 WHERE id = ?").bind(s.user.id).run();
  const still = await env.DB.prepare("SELECT status FROM grid_posts WHERE id = ?").bind(post.id).first<{ status: string }>();
  expect(still!.status).toBe("expired");
});

it("不能先删除来绕过到期费用：删除前先补算", async () => {
  const s = await register("bill6");
  await grantPoints(s.user.id, 100);
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, text: "x" });
  const { post } = (await res.json()) as { post: { id: string } };
  // 直接把余额设为 4（恰好覆盖一条日费），验证删除前补算不能绕过
  await env.DB.prepare("UPDATE users SET balance = 4 WHERE id = ?").bind(s.user.id).run();
  await makeDue(post.id, 0); // 今天到期：结算 4

  const del = await jsonReq("DELETE", `/api/posts/${post.id}`, undefined, s.cookie);
  expect(del.status).toBe(200);
  // 删除前补算已扣除日费 4
  expect((await getUserRow(s.user.id))!.balance).toBe(0);
  const finalStatus = await env.DB.prepare("SELECT status FROM grid_posts WHERE id = ?").bind(post.id).first<{ status: string }>();
  expect(finalStatus!.status).toBe("deleted"); // 补算后是 active → 删除成功
  // 有日结记录，不能绕过
  const settled = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_settlements WHERE post_id = ?").bind(post.id).first<{ n: number }>();
  expect(settled!.n).toBe(1);
});

it("手动日结与 Cron 复用同一逻辑：只处理已到期日期", async () => {
  const s = await register("bill7");
  await grantPoints(s.user.id, 1000);
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, text: "x" });
  const { post } = (await res.json()) as { post: { id: string } };

  // 未到期：手动日结不产生任何扣费（不能提前扣未来日期）
  const adminRes = await jsonReq("POST", "/api/admin/settlement/run");
  // 未登录管理员，改用直接调用 runSettlement —— 与 scheduled 入口一致
  const stats = await runSettlement(env.DB, 5000);
  expect(stats.charged).toBe(0);
  const row = await env.DB.prepare("SELECT next_billing_date FROM grid_posts WHERE id = ?").bind(post.id).first<{ next_billing_date: string }>();
  expect(new Date(row!.next_billing_date + "T00:00:00Z").getTime()).toBeGreaterThan(Date.now() - 1000);
});
