/**
 * 发布、占格、并发冲突、请求幂等、编辑与删除测试。
 */
import { beforeEach, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getUserRow, jsonReq, ledgerSum, publish, register, reqId } from "./helpers";

beforeEach(async () => {
  // 统一费率便于断言：P=2, D=1（README 示例）
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

it("发布成功：扣发布费、占格、记账一次完成；面积与费用按公式计算", async () => {
  const s = await register("pub1");
  await grantPoints(s.user.id, 100);
  // 4×3 = 12 格，P=2 → 24 积分（README 示例）
  const res = await publish(s.cookie, { requestId: reqId(), x: 10, y: 20, width: 4, height: 3, text: "hello" });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { post: { id: string; x: number; y: number } };
  expect(data.post.x).toBe(10);

  expect((await getUserRow(s.user.id))!.balance).toBe(200 + 100 - 24); // 注册 200 + 补 100 - 发布费 24
  expect(await ledgerSum(s.user.id)).toBe(200 + 100 - 24);

  // 费率快照保存
  const post = await env.DB.prepare("SELECT price_p, price_d, next_billing_date FROM grid_posts WHERE id = ?")
    .bind(data.post.id)
    .first<{ price_p: number; price_d: number; next_billing_date: string }>();
  expect(post!.price_p).toBe(2);
  expect(post!.price_d).toBe(1);

  // 墙面可见
  const wall = (await (await jsonReq("GET", "/api/wall")).json()) as { posts: unknown[] };
  expect(wall.posts).toHaveLength(1);
});

it("非法边界：负数、越界、零尺寸、全墙超界被拒绝", async () => {
  const s = await register("pub2");
  await grantPoints(s.user.id, 1_000_000);
  const cases: Array<[number, number, number, number]> = [
    [-1, 0, 1, 1],
    [0, -1, 1, 1],
    [0, 0, 0, 1],
    [0, 0, 1, 0],
    [99, 0, 2, 1], // x + width > 100
    [0, 99, 1, 2],
    [100, 0, 1, 1],
  ];
  for (const [x, y, w, h] of cases) {
    const res = await publish(s.cookie, { requestId: reqId(), x, y, width: w, height: h, text: "t" });
    expect.soft(res.status, `case ${x},${y},${w},${h}`).toBe(400);
  }
  // 小数
  const frac = await jsonReq("POST", "/api/posts", { requestId: reqId(), x: 1.5, y: 0, width: 1, height: 1, text: "t" }, s.cookie);
  expect(frac.status).toBe(400);
  // 内容为空
  const empty = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 1, height: 1 });
  expect(empty.status).toBe(400);
  // 非法链接协议
  const jsLink = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 1, height: 1, text: "t", link: "javascript:alert(1)" });
  expect(jsLink.status).toBe(400);
});

it("余额不足时发布失败且无任何残留", async () => {
  const s = await register("pub3"); // 余额 200
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 20, height: 20, text: "big" }); // 400 格 × 2 = 800
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("insufficient_balance");
  expect((await getUserRow(s.user.id))!.balance).toBe(200);
  const cells = await env.DB.prepare("SELECT COUNT(*) AS n FROM grid_cells").first<{ n: number }>();
  expect(cells!.n).toBe(0);
  const ledger = await env.DB.prepare("SELECT COUNT(*) AS n FROM point_ledger WHERE reason = 'publish'").first<{ n: number }>();
  expect(ledger!.n).toBe(0);
});

it("并发占格：两个账户同时发布重叠区域，仅一个成功", async () => {
  const a = await register("conA");
  const b = await register("conB");
  await grantPoints(a.user.id, 1000);
  await grantPoints(b.user.id, 1000);
  const [ra, rb] = await Promise.all([
    publish(a.cookie, { requestId: reqId(), x: 5, y: 5, width: 10, height: 10, text: "A" }),
    publish(b.cookie, { requestId: reqId(), x: 10, y: 10, width: 10, height: 10, text: "B" }),
  ]);
  const statuses = [ra.status, rb.status].sort();
  expect(statuses).toEqual([200, 409]);
  // 成功方扣费，失败方无扣费
  const rows = await env.DB.prepare("SELECT username, balance FROM users WHERE username IN ('conA','conB')").all<{
    username: string;
    balance: number;
  }>();
  const byName = new Map(rows.results.map((r) => [r.username, r.balance]));
  const winners = [...byName.entries()].filter(([, bal]) => bal === 1200 - 200); // 100 格 × P2 = 200
  const losers = [...byName.entries()].filter(([, bal]) => bal === 1200);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
});

it("请求幂等：同请求 ID 重试返回原结果，改内容被拒绝", async () => {
  const s = await register("idem");
  await grantPoints(s.user.id, 100);
  const id = reqId();
  const first = await publish(s.cookie, { requestId: id, x: 0, y: 0, width: 2, height: 2, text: "same" });
  expect(first.status).toBe(200);
  const firstData = (await first.json()) as { post: { id: string } };

  const retry = await publish(s.cookie, { requestId: id, x: 0, y: 0, width: 2, height: 2, text: "same" });
  expect(retry.status).toBe(200);
  const retryData = (await retry.json()) as { post: { id: string }; replayed: boolean };
  expect(retryData.replayed).toBe(true);
  expect(retryData.post.id).toBe(firstData.post.id);
  expect((await getUserRow(s.user.id))!.balance).toBe(200 + 100 - 8);

  const changed = await publish(s.cookie, { requestId: id, x: 1, y: 1, width: 2, height: 2, text: "different" });
  expect(changed.status).toBe(409);
});

it("越权：用户不能修改或删除他人内容", async () => {
  const a = await register("ownerA");
  const b = await register("ownerB");
  await grantPoints(a.user.id, 100);
  const res = await publish(a.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, text: "mine" });
  const { post } = (await res.json()) as { post: { id: string } };

  const edit = await jsonReq("PATCH", `/api/posts/${post.id}`, { text: "hacked" }, b.cookie);
  expect(edit.status).toBe(403);
  const del = await jsonReq("DELETE", `/api/posts/${post.id}`, undefined, b.cookie);
  expect(del.status).toBe(403);
  const still = await env.DB.prepare("SELECT text FROM grid_posts WHERE id = ?").bind(post.id).first<{ text: string }>();
  expect(still!.text).toBe("mine");
});

it("编辑不改变计费快照与位置；删除释放全部坐标且不退款", async () => {
  const s = await register("editor");
  await grantPoints(s.user.id, 100);
  const res = await publish(s.cookie, { requestId: reqId(), x: 3, y: 3, width: 3, height: 2, text: "before" });
  const { post } = (await res.json()) as { post: { id: string } };

  const edit = await jsonReq("PATCH", `/api/posts/${post.id}`, { text: "after", link: "https://example.com" }, s.cookie);
  expect(edit.status).toBe(200);
  const row = await env.DB.prepare("SELECT text, x, y, width, height, price_p, price_d FROM grid_posts WHERE id = ?")
    .bind(post.id)
    .first();
  expect(row).toMatchObject({ text: "after", x: 3, y: 3, width: 3, height: 2, price_p: 2, price_d: 1 });

  const cellsBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM grid_cells WHERE post_id = ?").bind(post.id).first<{ n: number }>();
  expect(cellsBefore!.n).toBe(6);

  const del = await jsonReq("DELETE", `/api/posts/${post.id}`, undefined, s.cookie);
  expect(del.status).toBe(200);
  const cellsAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM grid_cells WHERE post_id = ?").bind(post.id).first<{ n: number }>();
  expect(cellsAfter!.n).toBe(0);
  // 已扣费用不退
  expect((await getUserRow(s.user.id))!.balance).toBe(200 + 100 - 12);
  const status = await env.DB.prepare("SELECT status FROM grid_posts WHERE id = ?").bind(post.id).first<{ status: string }>();
  expect(status!.status).toBe("deleted");
  // 区域可被他人重新占用
  const other = await register("taker");
  await grantPoints(other.user.id, 100);
  const republish = await publish(other.cookie, { requestId: reqId(), x: 3, y: 3, width: 3, height: 2, text: "new" });
  expect(republish.status).toBe(200);
});

it("发布当日不收日费，首次日结在下一 UTC 日界线", async () => {
  const s = await register("dayline");
  await grantPoints(s.user.id, 100);
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 4, height: 3, text: "x" }); // 12 格
  const { post } = (await res.json()) as { post: { id: string } };
  const row = await env.DB.prepare("SELECT next_billing_date, created_at FROM grid_posts WHERE id = ?")
    .bind(post.id)
    .first<{ next_billing_date: string; created_at: number }>();
  const today = new Date().toISOString().slice(0, 10);
  expect(row!.next_billing_date).not.toBe(today); // 下一个 UTC 日界线
  const tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 86400_000).toISOString().slice(0, 10);
  expect(row!.next_billing_date).toBe(tomorrow);
  expect((await getUserRow(s.user.id))!.balance).toBe(200 + 100 - 24); // 只扣发布费
});
