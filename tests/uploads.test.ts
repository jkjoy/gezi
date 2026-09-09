/**
 * 图片上传、内容安全与清理测试。
 */
import { beforeEach, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { jsonReq, publish, register, reqId, tinyPng, uploadImage } from "./helpers";

beforeEach(async () => {
  await env.DB.prepare("UPDATE system_settings SET value = '2' WHERE key = 'publish_price_p'").run();
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

it("上传合法 PNG 成功，发布时可引用", async () => {
  const s = await register("up1");
  const up = await uploadImage(s.cookie, tinyPng());
  expect(up.status).toBe(200);
  const data = (await up.json()) as { id: string; url: string; mime: string };
  expect(data.mime).toBe("image/png");

  await grantPoints(s.user.id, 100);
  const res = await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, imageId: data.id });
  expect(res.status).toBe(200);

  // 图片可通过带 nosniff 的响应访问
  const img = await jsonReq("GET", data.url);
  expect(img.status).toBe(200);
  expect(img.headers.get("content-type")).toBe("image/png");
  expect(img.headers.get("x-content-type-options")).toBe("nosniff");
});

it("伪造 MIME、SVG、HTML 被拒绝", async () => {
  const s = await register("up2");
  // SVG 内容声明 PNG
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const fake = await uploadImage(s.cookie, svg, "evil.png");
  expect(fake.status).toBe(415);

  const html = new TextEncoder().encode("<!doctype html><html><body>x</body></html>");
  const fakeHtml = await uploadImage(s.cookie, html, "evil.png");
  expect(fakeHtml.status).toBe(415);

  // 空文件
  const empty = await uploadImage(s.cookie, new Uint8Array(0), "empty.png");
  expect(empty.status).toBe(400);
});

it("引用他人图片或不存在图片被拒绝", async () => {
  const a = await register("up3a");
  const b = await register("up3b");
  const up = await uploadImage(a.cookie, tinyPng());
  const data = (await up.json()) as { id: string };

  await grantPoints(b.user.id, 100);
  const steal = await publish(b.cookie, { requestId: reqId(), x: 0, y: 0, width: 1, height: 1, imageId: data.id });
  expect(steal.status).toBe(400);
  expect(((await steal.json()) as { error: string }).error).toBe("image_unavailable");

  const missing = await publish(b.cookie, { requestId: reqId(), x: 0, y: 0, width: 1, height: 1, imageId: "nonexistent" });
  expect(missing.status).toBe(400);
});

it("超过大小限制被拒绝", async () => {
  const s = await register("up4");
  // 把上限调到允许的最小值 1024 字节；合法 PNG + 填充超限（服务端钳位下限也是 1024）
  await env.DB.prepare("UPDATE system_settings SET value = '1024' WHERE key = 'upload_max_bytes'").run();
  const png = tinyPng();
  const big = new Uint8Array(2000);
  big.set(png); // 完整合法 PNG（1×1）在前，剩余填充使总大小超限
  const res = await uploadImage(s.cookie, big);
  expect(res.status).toBe(413);
});

it("孤儿清理：未被有效引用的图片可清理，被引用的不被误删", async () => {
  const s = await register("up5");
  const up1 = await uploadImage(s.cookie, tinyPng());
  const img1 = (await up1.json()) as { id: string; key: string };
  const up2 = await uploadImage(s.cookie, tinyPng());
  const img2 = (await up2.json()) as { id: string; key: string };

  // img1 被有效内容引用；img2 放弃发布成为孤儿
  await grantPoints(s.user.id, 100);
  await publish(s.cookie, { requestId: reqId(), x: 0, y: 0, width: 2, height: 2, imageId: img1.id });

  // 人为把孤儿时间拨到宽限期之前
  await env.DB.prepare("UPDATE uploads SET created_at = ? WHERE id = ?").bind(Date.now() - 48 * 3600_000, img2.id).run();

  const { cleanupOrphanUploads } = await import("../src/uploads");
  const stats = await cleanupOrphanUploads(env.DB, env.UPLOADS);
  expect(stats.marked).toBe(1);
  expect(stats.deleted).toBe(1);

  const s1 = await env.DB.prepare("SELECT status FROM uploads WHERE id = ?").bind(img1.id).first<{ status: string }>();
  const s2 = await env.DB.prepare("SELECT status FROM uploads WHERE id = ?").bind(img2.id).first<{ status: string }>();
  expect(s1!.status).toBe("available");
  expect(s2!.status).toBe("deleted");

  // 被引用图片仍可访问，孤儿 404
  const live = await jsonReq("GET", `/api/images/${img1.key}`);
  expect(live.status).toBe(200);
  const gone = await jsonReq("GET", `/api/images/${img2.key}`);
  expect(gone.status).toBe(404);
});

it("路径遍历与非法对象键被拒绝", async () => {
  const res = await jsonReq("GET", "/api/images/u/../etc/passwd");
  expect(res.status).toBe(404);
  const res2 = await jsonReq("GET", "/api/images/not-a-key");
  expect(res2.status).toBe(404);
});
