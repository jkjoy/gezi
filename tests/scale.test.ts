/**
 * 极端规模测试：一条内容占满全墙（10,000 格）验证大事务边界；
 * 多条单格内容验证墙面查询与批量语句。
 */
import { beforeEach, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getUserRow, jsonReq, publish, register, reqId } from "./helpers";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE system_settings SET value = '1' WHERE key = 'publish_price_p'"),
    env.DB.prepare("UPDATE system_settings SET value = '0' WHERE key = 'daily_price_d'"),
  ]);
});

it("一条内容占满全墙：10,000 格原子写入", async () => {
  const s = await register("full1");
  await env.DB.prepare("UPDATE users SET balance = 20000 WHERE id = ?").bind(s.user.id).run();
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 100, height: 100, text: "全墙" });
  expect(res.status).toBe(200);
  const cells = await env.DB.prepare("SELECT COUNT(*) AS n FROM grid_cells").first<{ n: number }>();
  expect(cells!.n).toBe(10000);
  expect((await getUserRow(s.user.id))!.balance).toBe(20000 - 10000);

  // 墙面数据返回
  const wall = (await (await jsonReq("GET", "/api/wall")).json()) as { posts: Array<{ width: number; height: number }> };
  expect(wall.posts).toHaveLength(1);
  expect(wall.posts[0]!.width).toBe(100);

  // 无剩余空间，第二条 1×1 发布失败
  await env.DB.prepare("UPDATE users SET balance = 9999 WHERE id = ?").bind(s.user.id).run();
  const second = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 1, height: 1, text: "no room" });
  expect(second.status).toBe(409);
  expect(((await second.json()) as { error: string }).error).toBe("area_conflict");
});

it("1,000 条单格内容：逐条占用与墙面响应", { timeout: 300_000 }, async () => {
  const s = await register("many1");
  await env.DB.prepare("UPDATE users SET balance = 100000 WHERE id = ?").bind(s.user.id).run();
  // 10×100 网格上放 1,000 条 1×1（10 行）
  // 分批并发发布：每批 25 条（限流阈值 30 以内），批间清速率限制。
  // 真实用户不会每秒发 30 条；这里只验证数据规模下的占用与查询，不验证限流本身。
  for (let batch = 0; batch < 40; batch++) {
    if (batch > 0) {
      await env.DB.prepare("DELETE FROM rate_limits WHERE bucket LIKE 'pub:%'").run();
    }
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, j) => {
        const i = batch * 25 + j;
        return publish(s.cookie, { requestId: reqId(), x: i % 100, y: Math.floor(i / 100), width: 1, height: 1, text: `#${i}` });
      })
    );
    for (let i = 0; i < results.length; i++) {
      const res = results[i]!;
      if (res.status !== 200) throw new Error(`post ${batch * 25 + i} failed: ${res.status} ${await res.text()}`);
    }
  }
  const cells = await env.DB.prepare("SELECT COUNT(*) AS n FROM grid_cells").first<{ n: number }>();
  expect(cells!.n).toBe(1000);
  const wall = (await (await jsonReq("GET", "/api/wall")).json()) as { posts: unknown[] };
  expect(wall.posts).toHaveLength(1000);
  expect((await getUserRow(s.user.id))!.balance).toBe(100000 - 1000);
});
