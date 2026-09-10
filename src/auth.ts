/**
 * auth.ts — 注册、登录、退出、会话与密码。
 *
 * 密码：PBKDF2-SHA256 + 独立随机盐。迭代次数按 Workers CPU 额度校准：
 * 免费计划单次请求 CPU 约 10ms，如登录出现 CPU 超限（错误 1102），应降低该值
 * 并要求受影响用户重新设置密码。
 */
import {
  AppError,
  type Ctx,
  type Env,
  type SessionUser,
  USERNAME_RE,
  asStr,
  clearedSessionCookie,
  constantTimeEqual,
  json,
  nowMs,
  randomId,
  randomToken,
  readCookie,
  readJson,
  readSettings,
  requireBody,
  sha256Hex,
  sessionCookie,
  toBase64,
  toHex,
  trustedClientIp,
  rateLimit,
} from "./util.js";

const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) return false;
  const salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
  const expect = Uint8Array.from(atob(parts[3]), (c) => c.charCodeAt(0));
  const actual = await pbkdf2Bits(password, salt, iterations);
  if (actual.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= actual[i]! ^ expect[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export async function createSession(env: Env, userId: string): Promise<{ token: string; maxAgeSec: number }> {
  const settings = await readSettings(env);
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = nowMs();
  const expiresAt = now + settings.sessionTtlHours * 3600_000;
  // 登录即清理：删除该用户已过期会话，并保留最近 9 个活跃会话，
  // 防止反复登录导致 sessions 表无限增长（新的在第 10 个，插入后共 10 个）
  await env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND (
       expires_at < ? OR token_hash IN (
         SELECT token_hash FROM sessions WHERE user_id = ? AND expires_at >= ?
         ORDER BY created_at DESC LIMIT -1 OFFSET 9
       )
    )`
  )
    .bind(userId, now, userId, now)
    .run();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, userId, now, expiresAt)
    .run();
  return { token, maxAgeSec: settings.sessionTtlHours * 3600 };
}

export async function getSessionUser(env: Env, req: Request): Promise<SessionUser | null> {
  const token = readCookie(req.headers.get("cookie"), "gw_session");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.balance, u.invite_code
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(tokenHash, nowMs())
    .first<{ id: string; username: string; role: string; balance: number; invite_code: string }>();
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role === "admin" ? "admin" : "user",
    balance: row.balance,
    invite_code: row.invite_code,
  };
}

export function publicUser(u: SessionUser): Record<string, unknown> {
  return { id: u.id, username: u.username, role: u.role, balance: u.balance, inviteCode: u.invite_code };
}

// ---------------------------------------------------------------------------
// 用户创建（注册与管理员初始化共用）
// ---------------------------------------------------------------------------

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function genInviteCode(): string {
  const buf = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(buf, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

export async function createUser(env: Env, username: string, password: string, role: "user" | "admin"): Promise<string> {
  const passwordHash = await hashPassword(password);
  const uid = randomId("u");
  const settings = await readSettings(env);
  // 管理员初始化账户不发注册奖励，需要积分时由批量赠送发放
  const reward = role === "user" ? settings.registerReward : 0;
  const now = nowMs();
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = genInviteCode();
    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO users (id, username, username_lower, password_hash, role, balance, invite_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uid, username, username.toLowerCase(), passwordHash, role, reward, code, now),
    ];
    if (reward > 0) {
      // 注册奖励：用户行与账本同一事务写入；balance_after 直接取 users.balance
      stmts.push(
        env.DB.prepare(
          `INSERT INTO point_ledger (user_id, amount, balance_after, reason, business_key, note, created_at)
           SELECT ?, ?, balance, 'register', 'register', ?, ? FROM users WHERE id = ?`
        ).bind(uid, reward, "注册奖励", now, uid)
      );
    }
    try {
      await env.DB.batch(stmts);
      return uid;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes("UNIQUE constraint failed: users.invite_code")) continue; // 邀请码撞码，换一个重试
      if (msg.includes("UNIQUE constraint failed: users.username_lower")) {
        throw new AppError("username_taken", "用户名已被占用", 409);
      }
      throw e;
    }
  }
  throw new AppError("internal", "创建用户失败，请重试", 500);
}

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------

export async function handleRegister(ctx: Ctx): Promise<Response> {
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const username = asStr(body.username, 24, "用户名");
  const password = asStr(body.password, 64, "密码", false);
  if (!USERNAME_RE.test(username)) {
    throw new AppError("bad_username", "用户名需为 3-24 位字母、数字、下划线或连字符", 400);
  }
  if (password.length < 8) throw new AppError("bad_password", "密码至少 8 位", 400);

  const ip = trustedClientIp(ctx.req) ?? "unknown";
  await rateLimit(ctx.env, `reg:${ip}`, 5, 3600_000);

  const uid = await createUser(ctx.env, username, password, "user");
  const { token, maxAgeSec } = await createSession(ctx.env, uid);
  const user = await mustGetUser(ctx.env, uid);
  return json(
    { user: publicUser(user) },
    200,
    { "set-cookie": sessionCookie(token, maxAgeSec, ctx.url.protocol === "https:") }
  );
}

export async function handleLogin(ctx: Ctx): Promise<Response> {
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const username = asStr(body.username, 24, "用户名");
  const password = asStr(body.password, 64, "密码", false);

  const ip = trustedClientIp(ctx.req) ?? "unknown";
  await rateLimit(ctx.env, `login:${ip}`, 20, 10 * 60_000);
  await rateLimit(ctx.env, `loginu:${username.toLowerCase()}`, 10, 10 * 60_000);

  const row = await ctx.env.DB.prepare(
    "SELECT id, username, role, balance, invite_code, password_hash FROM users WHERE username_lower = ?"
  )
    .bind(username.toLowerCase())
    .first<{
      id: string;
      username: string;
      role: string;
      balance: number;
      invite_code: string;
      password_hash: string;
    }>();
  const ok = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, FALLBACK_HASH);
  if (!row || !ok) {
    // 统一错误信息，不区分“用户不存在”与“密码错误”
    throw new AppError("bad_credentials", "用户名或密码错误", 401);
  }
  const { token, maxAgeSec } = await createSession(ctx.env, row.id);
  return json(
    {
      user: {
        id: row.id,
        username: row.username,
        role: row.role === "admin" ? "admin" : "user",
        balance: row.balance,
        inviteCode: row.invite_code,
      },
    },
    200,
    { "set-cookie": sessionCookie(token, maxAgeSec, ctx.url.protocol === "https:") }
  );
}

// 用户不存在时也执行一次校验，抹平响应时间差异（全零盐 + 全零摘要的合法占位哈希）
const FALLBACK_HASH = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==${"$"}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

export async function handleLogout(ctx: Ctx): Promise<Response> {
  const token = readCookie(ctx.req.headers.get("cookie"), "gw_session");
  if (token) {
    const tokenHash = await sha256Hex(token);
    await ctx.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
}

export async function handleMe(ctx: Ctx): Promise<Response> {
  if (!ctx.user) return json({ user: null });
  const stats = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS visits, COALESCE(SUM(reward_amount), 0) AS earned
     FROM invite_visits WHERE inviter_id = ? AND reward_amount IS NOT NULL`
  )
    .bind(ctx.user.id)
    .first<{ visits: number; earned: number }>();
  return json({
    user: publicUser(ctx.user),
    invite: { visits: stats?.visits ?? 0, earned: stats?.earned ?? 0 },
  });
}

export async function mustGetUser(env: Env, userId: string): Promise<SessionUser> {
  const row = await env.DB.prepare("SELECT id, username, role, balance, invite_code FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; username: string; role: string; balance: number; invite_code: string }>();
  if (!row) throw new AppError("user_not_found", "用户不存在", 404);
  return {
    id: row.id,
    username: row.username,
    role: row.role === "admin" ? "admin" : "user",
    balance: row.balance,
    invite_code: row.invite_code,
  };
}

// 导出供测试使用
export const _internal = { constantTimeEqual, toHex };
