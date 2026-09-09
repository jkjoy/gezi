/**
 * util.ts — 基础工具：类型、错误、响应、参数校验、随机 ID、哈希、
 * 速率限制、账户协调租约、配置读取与审计日志。
 */

export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
  ASSETS?: Fetcher;
  INVITE_HASH_SECRET: string;
  ADMIN_INIT_TOKEN: string;
  ADMIN_INIT_USERNAME: string;
  ADMIN_INIT_PASSWORD: string;
}

export interface SessionUser {
  id: string;
  username: string;
  role: "user" | "admin";
  balance: number;
  invite_code: string;
}

export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  user: SessionUser | null;
}

/** 墙面与内容常量（README：默认 100×100 格，每格 10×10 逻辑像素） */
export const GRID = 100;
export const CELL_PX = 10;
export const TEXT_MAX = 500;
export const LINK_MAX = 300;
export const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 带业务错误码的异常，由顶层统一转成 JSON 响应 */
export class AppError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowMs(): number {
  return Date.now();
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export function toHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(prefix: string): string {
  return prefix + randomHex(12);
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function toBase64Url(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

/** 恒定时间比较，避免时序侧信道 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

export function asInt(v: unknown, min: number, max: number, name = "参数"): number {
  let n: number | null = null;
  if (typeof v === "number" && Number.isInteger(v)) n = v;
  else if (typeof v === "string" && /^-?\d+$/.test(v)) n = Number(v);
  if (n === null || Number.isNaN(n) || n < min || n > max) {
    throw new AppError("bad_param", `${name} 必须是 ${min} 到 ${max} 之间的整数`, 400);
  }
  return n;
}

export function asStr(v: unknown, max: number, name = "参数", trim = true): string {
  if (typeof v !== "string") throw new AppError("bad_param", `${name} 必须是字符串`, 400);
  const s = trim ? v.trim() : v;
  if (s.length > max) throw new AppError("bad_param", `${name} 长度不能超过 ${max}`, 400);
  if (s.includes("\u0000")) throw new AppError("bad_param", `${name} 含有非法字符`, 400);
  return s;
}

export function requireBody<T>(body: unknown): T {
  if (body === null || typeof body !== "object") {
    throw new AppError("bad_request", "请求体必须是 JSON 对象", 400);
  }
  return body as T;
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    throw new AppError("bad_request", "需要 application/json 请求体", 400);
  }
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError("too_large", "请求体过大", 413);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("bad_json", "无效的 JSON", 400);
  }
}

/** CSRF 防护：写请求必须携带与站点同源的 Origin（或同源 Sec-Fetch-Site） */
export function assertSameOrigin(req: Request): void {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (origin === "null") throw new AppError("csrf", "跨站请求被拒绝", 403);
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      throw new AppError("csrf", "跨站请求被拒绝", 403);
    }
    if (o.host !== url.host) throw new AppError("csrf", "跨站请求被拒绝", 403);
    return;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "same-site" || site === "none") return;
  // 浏览器总会带 Origin 或 Sec-Fetch-Site；都缺失时按非同源请求拒绝
  throw new AppError("csrf", "缺少同源校验头（Origin）", 403);
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

export interface Page {
  page: number;
  size: number;
  offset: number;
}

export function paginate(url: URL, defaultSize = 50): Page {
  const page = Math.max(1, asInt(url.searchParams.get("page") ?? "1", 1, 1_000_000, "page"));
  const size = Math.min(100, Math.max(1, asInt(url.searchParams.get("size") ?? String(defaultSize), 1, 100, "size")));
  return { page, size, offset: (page - 1) * size };
}

// ---------------------------------------------------------------------------
// Cookie / 客户端 IP
// ---------------------------------------------------------------------------

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const base = `gw_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  return secure ? base + "; Secure" : base;
}

export function clearedSessionCookie(): string {
  return "gw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

/**
 * 只信任 Cloudflare 提供的客户端 IP（CF-Connecting-IP）。
 * 生产环境该头由 Cloudflare 注入且不可伪造；本地开发 / 测试环境（Wrangler、
 * vitest-pool-workers）没有 CF 头，退回 X-Forwarded-For 的第一段以便联调。
 */
export function trustedClientIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 日期（UTC）
// ---------------------------------------------------------------------------

/** UTC 当日零点的毫秒时间戳 */
export function utcDayStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function utcDateStr(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// D1 错误分类
// ---------------------------------------------------------------------------

export type DbFail =
  | "cells_conflict"
  | "post_request_conflict"
  | "settlement_conflict"
  | "ledger_conflict"
  | "txn_used"
  | "invite_pair_conflict"
  | "balance"
  | "upload_guard"
  | "post_guard"
  | "order_guard"
  | "init_conflict"
  | "fk"
  | "other";

/**
 * D1 批量写入整体处于一个事务中，任何语句失败都会整体回滚。
 * 这里把 SQLite 错误消息映射回业务语义（唯一约束 → 409，CHECK 余额 → 余额不足等）。
 */
export function classifyDbError(e: unknown): DbFail {
  const msg = String((e as Error)?.message ?? e);
  if (/UNIQUE constraint failed: grid_cells\./.test(msg)) return "cells_conflict";
  if (/UNIQUE constraint failed: grid_posts\.user_id, grid_posts\.request_id/.test(msg)) return "post_request_conflict";
  if (/UNIQUE constraint failed: daily_settlements\.post_id/.test(msg)) return "settlement_conflict";
  if (/UNIQUE constraint failed: point_ledger\.user_id, point_ledger\.business_key/.test(msg)) return "ledger_conflict";
  if (/UNIQUE constraint failed: donation_orders\.channel, donation_orders\.txn_no/.test(msg)) return "txn_used";
  if (/UNIQUE constraint failed: invite_visits\.inviter_id, invite_visits\.ip_hash/.test(msg)) return "invite_pair_conflict";
  if (/CHECK constraint failed: users_balance_nonnegative/.test(msg)) return "balance";
  if (/NOT NULL constraint failed: uploads\.status/.test(msg)) return "upload_guard";
  if (/NOT NULL constraint failed: grid_posts\.(text|status|next_billing_date)/.test(msg)) return "post_guard";
  if (/NOT NULL constraint failed: donation_orders\.status/.test(msg)) return "order_guard";
  if (/NOT NULL constraint failed: system_settings\.value/.test(msg)) return "init_conflict";
  if (/FOREIGN KEY constraint failed/.test(msg)) return "fk";
  return "other";
}

// ---------------------------------------------------------------------------
// 速率限制（数据库原子窗口计数，适用于多实例）
// ---------------------------------------------------------------------------

export async function rateLimit(env: Env, bucket: string, limit: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
     RETURNING count`
  )
    .bind(bucket, now, now - windowMs, now - windowMs, now)
    .first<{ count: number }>();
  if (row && row.count > limit) {
    throw new AppError("rate_limited", "操作过于频繁，请稍后再试", 429);
  }
}

// ---------------------------------------------------------------------------
// 账户协调租约：同一账户的余额写操作串行化（README 数据模型中的“账户写入协调状态”）
// ---------------------------------------------------------------------------

const COORD_TTL_MS = 15_000;

export async function acquireCoord(db: D1Database, userId: string, attempts = 25, ttlMs = COORD_TTL_MS): Promise<string> {
  const token = randomId("c");
  for (let i = 0; i < attempts; i++) {
    const now = Date.now();
    const r = await db.prepare("UPDATE users SET coord_token = ?, coord_until = ? WHERE id = ? AND coord_until < ?")
      .bind(token, now + ttlMs, userId, now)
      .run();
    if (r.meta.changes === 1) return token;
    await sleep(100 + Math.random() * 150);
  }
  throw new AppError("coord_busy", "账户操作繁忙，请稍后重试", 503);
}

export async function renewCoord(db: D1Database, userId: string, token: string, ttlMs = COORD_TTL_MS): Promise<boolean> {
  const r = await db.prepare("UPDATE users SET coord_until = ? WHERE id = ? AND coord_token = ?")
    .bind(Date.now() + ttlMs, userId, token)
    .run();
  return r.meta.changes === 1;
}

export async function releaseCoord(db: D1Database, userId: string, token: string): Promise<void> {
  await db.prepare("UPDATE users SET coord_token = NULL, coord_until = 0 WHERE id = ? AND coord_token = ?")
    .bind(userId, token)
    .run();
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface Settings {
  publishPriceP: number;
  dailyPriceD: number;
  registerReward: number;
  inviteReward: number;
  inviteDailyCap: number;
  exchangeRate: number;
  donationMinFen: number;
  uploadMaxBytes: number;
  uploadMaxWidth: number;
  uploadMaxHeight: number;
  uploadMaxPixels: number;
  sessionTtlHours: number;
  adminInitialized: boolean;
}

const SETTING_DEFAULTS: Settings = {
  publishPriceP: 2,
  dailyPriceD: 1,
  registerReward: 200,
  inviteReward: 20,
  inviteDailyCap: 5,
  exchangeRate: 100,
  donationMinFen: 100,
  uploadMaxBytes: 2 * 1024 * 1024,
  uploadMaxWidth: 1024,
  uploadMaxHeight: 1024,
  uploadMaxPixels: 1024 * 1024,
  sessionTtlHours: 168,
  adminInitialized: false,
};

export async function readSettings(env: Env): Promise<Settings> {
  const rows = await env.DB.prepare("SELECT key, value FROM system_settings").all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  const num = (mapKey: string, def: number, min: number, max: number): number => {
    const raw = map.get(mapKey);
    const v = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(v)) return def;
    return Math.min(max, Math.max(min, Math.trunc(v)));
  };
  const d = SETTING_DEFAULTS;
  return {
    publishPriceP: num("publish_price_p", d.publishPriceP, 0, 1_000_000),
    dailyPriceD: num("daily_price_d", d.dailyPriceD, 0, 1_000_000),
    registerReward: num("register_reward", d.registerReward, 0, 1_000_000),
    inviteReward: num("invite_reward", d.inviteReward, 0, 1_000_000),
    inviteDailyCap: num("invite_daily_cap", d.inviteDailyCap, 0, 1000),
    exchangeRate: num("exchange_rate", d.exchangeRate, 1, 1_000_000),
    donationMinFen: num("donation_min_fen", d.donationMinFen, 1, 100_000_000),
    uploadMaxBytes: num("upload_max_bytes", d.uploadMaxBytes, 1024, 20 * 1024 * 1024),
    uploadMaxWidth: num("upload_max_width", d.uploadMaxWidth, 10, 4096),
    uploadMaxHeight: num("upload_max_height", d.uploadMaxHeight, 10, 4096),
    uploadMaxPixels: num("upload_max_pixels", d.uploadMaxPixels, 1024, 16_777_216),
    sessionTtlHours: num("session_ttl_hours", d.sessionTtlHours, 1, 8760),
    adminInitialized: (map.get("admin_initialized") ?? "0") === "1",
  };
}

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

export async function audit(
  env: Env,
  actorId: string | null,
  action: string,
  objectType?: string,
  objectId?: string,
  detail?: unknown
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (actor_id, action, object_type, object_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(
      actorId,
      action,
      objectType ?? null,
      objectId ?? null,
      detail === undefined ? null : JSON.stringify(detail).slice(0, 2000),
      Date.now()
    )
    .run();
}

// ---------------------------------------------------------------------------
// 余额原子变动（要求调用者已持有该账户的协调租约）
// ---------------------------------------------------------------------------

/**
 * 原子扣费语句：CASE 保证用户不存在时直接报错而不是静默改 0 行；
 * 余额不足触发 users_balance_nonnegative CHECK，整个批量事务回滚。
 */
export function debitUserStmt(db: D1Database, userId: string, amount: number): D1PreparedStatement {
  return db
    .prepare("UPDATE users SET balance = CASE WHEN id = ? THEN balance - ? ELSE NULL END WHERE id = ?")
    .bind(userId, amount, userId);
}

export function creditUserStmt(db: D1Database, userId: string, amount: number): D1PreparedStatement {
  return db
    .prepare("UPDATE users SET balance = CASE WHEN id = ? THEN balance + ? ELSE NULL END WHERE id = ?")
    .bind(userId, amount, userId);
}

/** 账本插入：balance_after 从扣费/入账之后的 users.balance 读取，两者天然一致 */
export function ledgerStmt(
  db: D1Database,
  userId: string,
  amount: number,
  reason: string,
  businessKey: string,
  note: string | null,
  now: number,
  guardSql = "1=1",
  guardParams: unknown[] = []
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO point_ledger (user_id, amount, balance_after, reason, business_key, note, created_at)
       SELECT ?, ?, balance, ?, ?, ?, ? FROM users WHERE id = ? AND ${guardSql}`
    )
    .bind(userId, amount, reason, businessKey, note, now, userId, ...guardParams);
}
