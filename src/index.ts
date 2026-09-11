/**
 * index.ts — Worker 入口：fetch / scheduled、路由与静态资源。
 *
 * /api/* 全部进入本 Worker（wrangler.toml 中 run_worker_first 保证不被静态资源
 * 直接处理），其余路径交给 Workers Static Assets。
 */
import { AppError, type Ctx, type Env, type SessionUser, asStr, assertSameOrigin, json, readSettings } from "./util.js";
import { getSessionUser, handleLogin, handleLogout, handleMe, handleRegister } from "./auth.js";
import {
  handleDeletePost,
  handleEditPost,
  handleMyPosts,
  handlePostDetail,
  handlePublish,
  handleWall,
} from "./posts.js";
import { handleCancelOrder, handleCreateOrder, handleInviteVisit, handleListLedger, handleListOrders } from "./points.js";
import { handleImage, handleUpload, cleanupOrphanUploads } from "./uploads.js";
import {
  handleAdminInit,
  handleAdminOrders,
  handleAdminUsers,
  handleAuditLogs,
  handleCleanupRun,
  handleConfirmOrder,
  handleCreateBulkGrant,
  handleGetSettings,
  handleListBulkGrants,
  handlePreviewUsers,
  handleRetryBulkGrant,
  handleSettlementRun,
  handleUpdateSettings,
} from "./admin.js";
import { runSettlement } from "./billing.js";

type Auth = "public" | "user" | "admin";
type Handler = (ctx: Ctx) => Promise<Response>;

interface RouteDef {
  method: string;
  re: RegExp;
  keys: string[];
  auth: Auth;
  handler: Handler;
}

const routes: RouteDef[] = [];

function route(method: string, pattern: string, auth: Auth, handler: Handler): void {
  const keys: string[] = [];
  const re = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => {
          if (seg === "*") {
            keys.push("key");
            return "(.+)";
          }
          if (seg.startsWith(":")) {
            keys.push(seg.slice(1));
            return "([^/]+)";
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$"
  );
  routes.push({ method, re, keys, auth, handler });
}

// ---- 公开接口 ----
route("GET", "/api/health", "public", async () => json({ ok: true }));
route("GET", "/api/config", "public", handleConfig);
route("GET", "/api/wall", "public", (ctx) => handleWall(ctx));
route("GET", "/api/posts/:id", "public", (ctx) => handlePostDetail(ctx));
route("POST", "/api/invite/visit", "public", (ctx) => handleInviteVisit(ctx));
route("GET", "/api/images/*", "public", (ctx) => handleImage(ctx));

// ---- 认证 ----
route("POST", "/api/auth/register", "public", (ctx) => handleRegister(ctx));
route("POST", "/api/auth/login", "public", (ctx) => handleLogin(ctx));
route("POST", "/api/auth/logout", "public", (ctx) => handleLogout(ctx));
route("GET", "/api/auth/me", "public", (ctx) => handleMe(ctx));

// ---- 用户 ----
route("GET", "/api/me/posts", "user", (ctx) => handleMyPosts(ctx));
route("GET", "/api/me/ledger", "user", (ctx) => handleListLedger(ctx));
route("GET", "/api/me/orders", "user", (ctx) => handleListOrders(ctx));
route("POST", "/api/me/orders", "user", (ctx) => handleCreateOrder(ctx));
route("POST", "/api/me/orders/:id/cancel", "user", (ctx) => handleCancelOrder(ctx));
route("POST", "/api/uploads", "user", (ctx) => handleUpload(ctx));
route("POST", "/api/posts", "user", (ctx) => handlePublish(ctx));
route("PATCH", "/api/posts/:id", "user", (ctx) => handleEditPost(ctx));
route("DELETE", "/api/posts/:id", "user", (ctx) => handleDeletePost(ctx));

// ---- 管理员 ----
// 初始化入口保持 public：首次部署时还没有管理员会话，端点内部自行校验一次性开关
route("POST", "/api/admin/init", "public", (ctx) => handleAdminInit(ctx));
route("GET", "/api/admin/settings", "admin", (ctx) => handleGetSettings(ctx));
route("PUT", "/api/admin/settings", "admin", (ctx) => handleUpdateSettings(ctx));
route("GET", "/api/admin/users", "admin", (ctx) => handleAdminUsers(ctx));
route("POST", "/api/admin/users/preview", "admin", (ctx) => handlePreviewUsers(ctx));
route("POST", "/api/admin/bulk-grants", "admin", (ctx) => handleCreateBulkGrant(ctx));
route("GET", "/api/admin/bulk-grants", "admin", (ctx) => handleListBulkGrants(ctx));
route("POST", "/api/admin/bulk-grants/:batch/retry", "admin", (ctx) => handleRetryBulkGrant(ctx));
route("GET", "/api/admin/donation-orders", "admin", (ctx) => handleAdminOrders(ctx));
route("POST", "/api/admin/donation-orders/:id/confirm", "admin", (ctx) => handleConfirmOrder(ctx));
route("POST", "/api/admin/settlement/run", "admin", (ctx) => handleSettlementRun(ctx));
route("POST", "/api/admin/cleanup/run", "admin", (ctx) => handleCleanupRun(ctx));
route("GET", "/api/admin/audit-logs", "admin", (ctx) => handleAuditLogs(ctx));

async function handleConfig(ctx: Ctx): Promise<Response> {
  const s = await readSettings(ctx.env);
  return json({
    grid: 100,
    cellPx: 10,
    publishPriceP: s.publishPriceP,
    dailyPriceD: s.dailyPriceD,
    exchangeRate: s.exchangeRate,
    donationMinFen: s.donationMinFen,
    uploadMaxBytes: s.uploadMaxBytes,
    uploadMaxWidth: s.uploadMaxWidth,
    uploadMaxHeight: s.uploadMaxHeight,
    textMax: 500,
    linkMax: 300,
  });
}

function matchRoute(method: string, pathname: string): { def: RouteDef; params: Record<string, string> } | null {
  for (const def of routes) {
    if (def.method !== method) continue;
    const m = def.re.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    def.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1]!);
    });
    return { def, params };
  }
  return null;
}

/**
 * 统一附加安全响应头。CSP 说明：
 *  - img-src 允许 self 与 data:（前端 img-preview 使用 blob 预览时可放宽）
 *  - script-src 仅 self（无内联脚本、无 CDN）
 *  - connect-src 仅 self（API 同域）
 */
function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const matched = matchRoute(req.method, url.pathname);
  if (matched) {
    let user: SessionUser | null = null;
    try {
      user = await getSessionUser(env, req);
      if (matched.def.auth !== "public") {
        if (!user) throw new AppError("unauthorized", "请先登录", 401);
        if (matched.def.auth === "admin" && user.role !== "admin") {
          throw new AppError("forbidden", "需要管理员权限", 403);
        }
      }
      // 写接口校验同源来源，防护 CSRF
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      const ctx: Ctx = { req, env, url, params: matched.params, user };
      return withSecurityHeaders(await matched.def.handler(ctx));
    } catch (e) {
      if (e instanceof AppError) return withSecurityHeaders(json({ error: e.code, message: e.message }, e.status));
      const path = url.pathname;
      if (!path.startsWith("/api/admin/")) console.error("request error:", path, e);
      return withSecurityHeaders(json({ error: "internal", message: "服务器内部错误" }, 500));
    }
  }
  if (url.pathname.startsWith("/api/")) {
    return withSecurityHeaders(json({ error: "not_found", message: "接口不存在" }, 404));
  }
  // 其余路径交给静态资源
  if (env.ASSETS) return env.ASSETS.fetch(req);
  return json({ error: "not_found", message: "接口不存在" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(req, env);
    } catch (e) {
      console.error("unhandled error:", e);
      return json({ error: "internal", message: "服务器内部错误" }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "0 1 * * *") {
      // 01:00 UTC：清理过期会话 / 速率记录 / 孤儿图片，并做一次日结兜底（幂等）
      ctx.waitUntil(
        (async () => {
          const now = Date.now();
          await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
          await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 48 * 3600_000).run();
          await cleanupOrphanUploads(env.DB, env.UPLOADS);
          await runSettlement(env.DB, 5 * 60_000);
        })()
      );
    } else {
      // 00:00 UTC：每日结算（按 UTC 自然日）
      ctx.waitUntil(runSettlement(env.DB, 12 * 60_000));
    }
  },
};
