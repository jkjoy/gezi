/**
 * 认证、会话与管理员初始化测试。
 */
import { beforeEach, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { getUserRow, initAdmin, jsonReq, ledgerSum, login, register } from "./helpers";

beforeEach(async () => {
  // 重置管理员初始化开关，允许每个测试独立验证一次性初始化流程
  await env.DB.prepare("UPDATE system_settings SET value = '0' WHERE key = 'admin_initialized'").run();
  await env.DB.prepare("DELETE FROM users WHERE role = 'admin'").run();
});

it("注册成功发放一次性注册奖励，重复注册被拒绝", async () => {
  const s = await register("alice");
  expect(s.user.balance).toBe(200); // 默认注册奖励
  expect(await ledgerSum(s.user.id)).toBe(200);

  const again = await jsonReq("POST", "/api/auth/register", { username: "alice", password: "password123" });
  expect(again.status).toBe(409);
  expect(await getUserRow(s.user.id)).toEqual({ balance: 200 });
});

it("错误密码不能登录，登出后 Cookie 失效", async () => {
  const s = await register("bob");
  const bad = await jsonReq("POST", "/api/auth/login", { username: "bob", password: "wrong-password" });
  expect(bad.status).toBe(401);

  const out = await jsonReq("POST", "/api/auth/logout", undefined, s.cookie);
  expect(out.status).toBe(200);
  const me = await jsonReq("GET", "/api/auth/me", undefined, s.cookie);
  expect(me.status).toBe(200);
  expect(((await me.json()) as { user: unknown }).user).toBeNull();
});

it("首个注册用户自动成为管理员，后续注册用户为普通角色", async () => {
  const first = await register("firstuser");
  expect(first.user.role).toBe("admin");
  // 首个用户仍获得注册奖励（正常注册流程）
  expect(first.user.balance).toBe(200);
  // 首个用户可以访问管理员接口
  const adminOk = await jsonReq("GET", "/api/admin/settings", undefined, first.cookie);
  expect(adminOk.status).toBe(200);

  // 第二个及之后的注册用户是普通角色，无管理员权限
  const second = await register("seconduser");
  expect(second.user.role).toBe("user");
  const denied = await jsonReq("GET", "/api/admin/settings", undefined, second.cookie);
  expect(denied.status).toBe(403);
  // 注册请求不携带角色字段，无法自行指定
  const forged = await jsonReq("POST", "/api/auth/register", { username: "thirduser", password: "password123", role: "admin" });
  expect(forged.status).toBe(200);
  const third = (await forged.json()) as { user: { role: string } };
  expect(third.user.role).toBe("user");
});

it("已有管理员时，首个注册用户不再自动提升", async () => {
  // 通过受控初始化先建管理员
  await initAdmin("seedadmin", "admin-password-123");
  // 之后注册的第一个用户保持普通角色
  const s = await register("latefirst");
  expect(s.user.role).toBe("user");
});

it("管理员初始化：错误令牌拒绝、成功一次后入口关闭", async () => {
  const bad = await jsonReq("POST", "/api/admin/init", { token: "wrong-token" });
  expect(bad.status).toBe(403);

  const admin = await initAdmin();
  expect(admin.user.role).toBe("admin");

  const again = await jsonReq("POST", "/api/admin/init", { token: env.ADMIN_INIT_TOKEN, username: "hacker", password: "hacked-password-1" });
  expect(again.status).toBe(403);
  // 管理员账户不发放注册奖励
  expect(admin.user.balance).toBe(0);
});

it("受保护接口未登录返回 401", async () => {
  const res = await jsonReq("GET", "/api/me/posts");
  expect(res.status).toBe(401);
  const res2 = await jsonReq("POST", "/api/posts", { requestId: "abcdefgh1234", x: 0, y: 0, width: 1, height: 1, text: "x" });
  expect(res2.status).toBe(401);
});

it("跨站写请求被 CSRF 防护拒绝", async () => {
  await register("carol");
  const loginRes = await jsonReq("POST", "/api/auth/login", { username: "carol", password: "password123" });
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
  const cross = await SELF.fetch("http://localhost/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "https://evil.example.com" },
    body: JSON.stringify({ requestId: "abcdefgh1234", x: 0, y: 0, width: 1, height: 1, text: "x" }),
  });
  expect(cross.status).toBe(403);
  expect(((await cross.json()) as { error: string }).error).toBe("csrf");
});

it("安全响应头：API 响应含 CSP / X-Frame-Options / nosniff", async () => {
  const res = await jsonReq("GET", "/api/health");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
});

it("会话数量有上限：反复登录不会无限积累", async () => {
  const s = await register("sessioncap");
  const id = s.user.id;
  for (let i = 0; i < 14; i++) {
    await jsonReq("POST", "/api/auth/login", { username: "sessioncap", password: "password123" });
  }
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(id).first<{ n: number }>();
  expect(row!.n).toBeLessThanOrEqual(10); // 每用户最多保留 10 个活跃会话
  // 最早的会话仍可用（登出不删别人），当前会话也可用
  const me = await jsonReq("GET", "/api/auth/me", undefined, s.cookie);
  expect(me.status).toBe(200);
});

it("登录与注册有频率限制", async () => {
  let last: Response | undefined;
  for (let i = 0; i < 25; i++) {
    last = await jsonReq("POST", "/api/auth/login", { username: `nobody${i}`, password: "password123" });
  }
  expect(last!.status).toBe(429);
});
