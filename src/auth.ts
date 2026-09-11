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
  audit,
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

/** 生成一次性恢复码（高熵，分 4 组便于抄录）与其 SHA-256 哈希；仅哈希入库 */
async function genRecovery(): Promise<{ code: string; hash: string }> {
  const buf = crypto.getRandomValues(new Uint8Array(20));
  const raw = Array.from(buf, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
  const code = (raw.match(/.{1,5}/g) || [raw]).join("-"); // XXXXX-XXXXX-XXXXX-XXXXX
  const hash = await sha256Hex(code);
  return { code, hash };
}

export async function createUser(env: Env, username: string, password: string, role: "user" | "admin"): Promise<{ uid: string; recoveryCode: string }> {
  const passwordHash = await hashPassword(password);
  const { code: recoveryCode, hash: recoveryHash } = await genRecovery();
  const uid = randomId("u");
  const settings = await readSettings(env);
  // 管理员初始化账户不发注册奖励，需要积分时由批量赠送发放
  const reward = role === "user" ? settings.registerReward : 0;
  const now = nowMs();
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = genInviteCode();
    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO users (id, username, username_lower, password_hash, role, balance, invite_code, recovery_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uid, username, username.toLowerCase(), passwordHash, role, reward, code, recoveryHash, now),
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
    if (role === "user") {
      // 首个注册用户自动成为管理员（2026-09-10 修订）：
      // 仅当当前不存在任何管理员时提升，判定与插入同事务，并发注册下 SQLite
      // 写串行化保证只有先提交的那个成为管理员；管理员初始化入口建号后此条件不再命中。
      stmts.push(
        env.DB.prepare(
          `UPDATE users SET role = 'admin' WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`
        ).bind(uid)
      );
    }
    try {
      await env.DB.batch(stmts);
      return { uid, recoveryCode };
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

  const { uid, recoveryCode } = await createUser(ctx.env, username, password, "user");
  const { token, maxAgeSec } = await createSession(ctx.env, uid);
  const user = await mustGetUser(ctx.env, uid);
  const roleMsg = user.role === "admin" ? "你是本站首位注册用户，已自动成为管理员。" : "";
  return json(
    {
      user: publicUser(user),
      message: `注册成功。${roleMsg}请妥善保存下方恢复码，忘记密码时用它重置（仅此一次展示）。`,
      recoveryCode,
    },
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

// ---------------------------------------------------------------------------
// 账户自助：修改密码 / 修改资料 / 重生成恢复码 / 忘记密码找回
// ---------------------------------------------------------------------------

/** 撤销某用户的全部会话（改密/找回后强制重新登录） */
async function revokeAllSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/** POST /api/me/password — 已登录改密码：验旧密码 → 换新 → 撤销全部会话 */
export async function handleChangePassword(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const oldPassword = asStr(body.oldPassword, 64, "原密码", false);
  const newPassword = asStr(body.newPassword, 64, "新密码", false);
  if (newPassword.length < 8) throw new AppError("bad_password", "新密码至少 8 位", 400);

  await rateLimit(ctx.env, `pwd:${user.id}`, 10, 3600_000);
  const row = await ctx.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(oldPassword, row.password_hash))) {
    throw new AppError("bad_credentials", "原密码错误", 401);
  }
  const newHash = await hashPassword(newPassword);
  await ctx.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(newHash, user.id).run();
  await revokeAllSessions(ctx.env, user.id);
  await audit(ctx.env, user.id, "account.password_change", "user", user.id);
  return json({ ok: true, message: "密码已修改，请用新密码重新登录。" }, 200, {
    "set-cookie": clearedSessionCookie(),
  });
}

/** PATCH /api/me/profile — 修改个人资料（当前支持用户名） */
export async function handleUpdateProfile(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  if (body.username === undefined) throw new AppError("bad_request", "没有需要修改的字段", 400);
  const username = asStr(body.username, 24, "用户名");
  if (!USERNAME_RE.test(username)) {
    throw new AppError("bad_username", "用户名需为 3-24 位字母、数字、下划线或连字符", 400);
  }
  if (username.toLowerCase() === user.username.toLowerCase()) {
    // 大小写调整允许；完全相同则直接返回
    if (username === user.username) return json({ user: publicUser({ ...user, username }) });
  }
  try {
    const r = await ctx.env.DB.prepare(
      "UPDATE users SET username = ?, username_lower = ? WHERE id = ?"
    )
      .bind(username, username.toLowerCase(), user.id)
      .run();
    if (r.meta.changes !== 1) throw new AppError("user_not_found", "用户不存在", 404);
  } catch (e) {
    if (String((e as Error)?.message ?? e).includes("UNIQUE constraint failed: users.username_lower")) {
      throw new AppError("username_taken", "用户名已被占用", 409);
    }
    throw e;
  }
  await audit(ctx.env, user.id, "account.profile_update", "user", user.id, { username });
  return json({ user: publicUser(await mustGetUser(ctx.env, user.id)) });
}

/** POST /api/me/recovery-code — 已登录重新生成恢复码（旧码失效，明文仅返回一次） */
export async function handleRegenRecovery(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const { code, hash } = await genRecovery();
  await ctx.env.DB.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?").bind(hash, user.id).run();
  await audit(ctx.env, user.id, "account.recovery_regen", "user", user.id);
  return json({ recoveryCode: code, message: "新恢复码已生成，请妥善保存；旧恢复码已失效。" });
}

/** POST /api/auth/recover — 未登录：用户名 + 恢复码 + 新密码 重置密码 */
export async function handleRecover(ctx: Ctx): Promise<Response> {
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const username = asStr(body.username, 24, "用户名");
  const recoveryCode = asStr(body.recoveryCode, 64, "恢复码");
  const newPassword = asStr(body.newPassword, 64, "新密码", false);
  if (newPassword.length < 8) throw new AppError("bad_password", "新密码至少 8 位", 400);

  const ip = trustedClientIp(ctx.req) ?? "unknown";
  await rateLimit(ctx.env, `recover:${ip}`, 10, 3600_000);
  await rateLimit(ctx.env, `recoveru:${username.toLowerCase()}`, 10, 3600_000);

  const row = await ctx.env.DB.prepare("SELECT id, recovery_hash FROM users WHERE username_lower = ?")
    .bind(username.toLowerCase())
    .first<{ id: string; recovery_hash: string | null }>();
  const codeHash = await sha256Hex(recoveryCode);
  // 恒定时间比较；用户不存在或未设恢复码时统一报错，不泄露账户状态
  const stored = row?.recovery_hash ?? "";
  if (!row || !stored || !constantTimeEqual(codeHash, stored)) {
    throw new AppError("bad_recovery", "用户名或恢复码错误，或该账户未设置恢复码", 401);
  }
  // 重置密码 + 轮换恢复码 + 撤销全部会话，同一批次提交
  const newHash = await hashPassword(newPassword);
  const next = await genRecovery();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE users SET password_hash = ?, recovery_hash = ? WHERE id = ?").bind(newHash, next.hash, row.id),
    ctx.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.id),
  ]);
  await audit(ctx.env, row.id, "account.recover", "user", row.id);
  return json({
    ok: true,
    recoveryCode: next.code,
    message: "密码已重置，请用新密码登录。恢复码已更新，请保存新的恢复码。",
  });
}
