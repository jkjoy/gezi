/**
 * admin.ts — 管理员：一次性初始化、系统配置、用户搜索、批量赠送、
 * 捐助确认、手动日结与操作记录。
 *
 * 关键规则（README §5）：
 *  * 首位管理员通过受控的一次性初始化流程绑定，初始化后入口永久关闭；
 *  * 捐助订单 pending → confirmed / cancelled 单向转换；确认时订单状态、积分入账、
 *    操作日志原子提交；同一渠道同一交易号只能关联一个订单；重复确认返回已有结果；
 *  * 批量赠送以“批次 ID + 用户 ID”去重，逐项记录结果，失败可安全重试。
 */
import {
  AppError,
  type Ctx,
  USERNAME_RE,
  asInt,
  asStr,
  classifyDbError,
  constantTimeEqual,
  creditUserStmt,
  audit,
  json,
  ledgerStmt,
  nowMs,
  paginate,
  randomId,
  rateLimit,
  readJson,
  readSettings,
  requireBody,
  trustedClientIp,
} from "./util.js";
import { catchUpUser, runSettlement } from "./billing.js";
import { hashPassword } from "./auth.js";
import { cleanupOrphanUploads } from "./uploads.js";
import { withCoord } from "./points.js";

// ---------------------------------------------------------------------------
// 一次性管理员初始化
// ---------------------------------------------------------------------------

export async function handleAdminInit(ctx: Ctx): Promise<Response> {
  const env = ctx.env;
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const ip = trustedClientIp(ctx.req) ?? "unknown";
  await rateLimit(env, `admininit:${ip}`, 5, 3600_000);

  const settings = await readSettings(env);
  if (settings.adminInitialized) throw new AppError("init_closed", "管理员初始化入口已关闭", 403);
  const existingAdmin = await env.DB.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").first();
  if (existingAdmin) throw new AppError("init_closed", "管理员已存在", 403);

  const token = asStr(body.token, 128, "初始化令牌", false);
  if (!constantTimeEqual(token, env.ADMIN_INIT_TOKEN)) {
    throw new AppError("bad_token", "初始化令牌错误", 403);
  }
  const username = asStr(body.username ?? env.ADMIN_INIT_USERNAME, 24, "用户名");
  const password = asStr(body.password ?? env.ADMIN_INIT_PASSWORD, 64, "密码", false);
  if (!USERNAME_RE.test(username)) {
    throw new AppError("bad_username", "用户名需为 3-24 位字母、数字、下划线或连字符", 400);
  }
  if (password.length < 10) throw new AppError("bad_password", "管理员密码至少 10 位", 400);

  const uid = randomId("u");
  const passwordHash = await hashPassword(password);
  const now = nowMs();
  try {
    // 单事务完成：建号 + 授予角色 + 关闭入口。并发重入时开关闭合失败整体回滚。
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, username, username_lower, password_hash, role, balance, invite_code, created_at)
         VALUES (?, ?, ?, ?, 'admin', 0, ?, ?)`
      ).bind(uid, username, username.toLowerCase(), passwordHash, randomId("A"), now),
      env.DB.prepare(
        `UPDATE system_settings SET value = CASE WHEN value = '0' THEN '1' ELSE NULL END, updated_at = ?
         WHERE key = 'admin_initialized'`
      ).bind(now),
    ]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("UNIQUE constraint failed: users.username_lower")) {
      throw new AppError("username_taken", "用户名已被占用，请换一个用户名", 409);
    }
    if (classifyDbError(e) === "init_conflict") throw new AppError("init_closed", "管理员初始化入口已关闭", 403);
    throw e;
  }
  await audit(env, uid, "admin.init", "user", uid, { username });
  return json({ ok: true, user: { id: uid, username, role: "admin" } });
}

// ---------------------------------------------------------------------------
// 系统配置
// ---------------------------------------------------------------------------

const SETTING_KEYS: Record<string, { min: number; max: number }> = {
  publishPriceP: { min: 0, max: 1_000_000 },
  dailyPriceD: { min: 0, max: 1_000_000 },
  registerReward: { min: 0, max: 1_000_000 },
  inviteReward: { min: 0, max: 1_000_000 },
  inviteDailyCap: { min: 0, max: 1000 },
  exchangeRate: { min: 1, max: 1_000_000 },
  donationMinFen: { min: 1, max: 100_000_000 },
  uploadMaxBytes: { min: 1024, max: 20 * 1024 * 1024 },
  uploadMaxWidth: { min: 10, max: 4096 },
  uploadMaxHeight: { min: 10, max: 4096 },
  uploadMaxPixels: { min: 1024, max: 16_777_216 },
  sessionTtlHours: { min: 1, max: 8760 },
};

const SETTING_KEY_MAP: Record<string, string> = {
  publishPriceP: "publish_price_p",
  dailyPriceD: "daily_price_d",
  registerReward: "register_reward",
  inviteReward: "invite_reward",
  inviteDailyCap: "invite_daily_cap",
  exchangeRate: "exchange_rate",
  donationMinFen: "donation_min_fen",
  uploadMaxBytes: "upload_max_bytes",
  uploadMaxWidth: "upload_max_width",
  uploadMaxHeight: "upload_max_height",
  uploadMaxPixels: "upload_max_pixels",
  sessionTtlHours: "session_ttl_hours",
};

export async function handleGetSettings(ctx: Ctx): Promise<Response> {
  const s = await readSettings(ctx.env);
  return json({ settings: s });
}

export async function handleUpdateSettings(ctx: Ctx): Promise<Response> {
  const admin = ctx.user!;
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const updates: Array<{ key: string; value: string }> = [];
  for (const [name, spec] of Object.entries(SETTING_KEYS)) {
    if (body[name] === undefined) continue;
    const v = asInt(body[name], spec.min, spec.max, name);
    updates.push({ key: SETTING_KEY_MAP[name], value: String(v) });
  }
  if (!updates.length) throw new AppError("bad_request", "没有需要更新的配置", 400);

  const now = nowMs();
  await ctx.env.DB.batch(
    updates.map((u) =>
      ctx.env.DB.prepare(
        `INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).bind(u.key, u.value, now, admin.id)
    )
  );
  await audit(ctx.env, admin.id, "settings.update", "settings", undefined, Object.fromEntries(updates.map((u) => [u.key, u.value])));
  const s = await readSettings(ctx.env);
  return json({ settings: s });
}

// ---------------------------------------------------------------------------
// 用户搜索
// ---------------------------------------------------------------------------

export async function handleAdminUsers(ctx: Ctx): Promise<Response> {
  const q = asStr(ctx.url.searchParams.get("q") ?? "", 24, "搜索词").toLowerCase();
  const { offset, page, size } = paginate(ctx.url);
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const total = await ctx.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE username_lower LIKE ? ESCAPE '\\'"
  )
    .bind(like)
    .first<{ n: number }>();
  const rows = await ctx.env.DB.prepare(
    `SELECT id, username, role, balance, created_at FROM users
     WHERE username_lower LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(like, size, offset)
    .all();
  return json({
    items: rows.results.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      balance: u.balance,
      createdAt: u.created_at,
    })),
    page,
    size,
    total: total?.n ?? 0,
  });
}

// ---------------------------------------------------------------------------
// 用户筛选（批量赠送按条件定位，不必手工收集 ID）
// ---------------------------------------------------------------------------

/**
 * 单次批量赠送覆盖的用户上限。
 * 超过上限时直接报错而不是静默截断——宁可让管理员缩小条件，
 * 也不能出现“以为发了 800 人、实际只发了前 500 人”的账实不符。
 */
const MAX_FILTER_USERS = 500;

export interface UserFilter {
  role?: "user" | "admin";
  balanceMin?: number;
  balanceMax?: number;
  createdFrom?: number; // 注册时间下界（含当日 00:00 UTC）
  createdTo?: number;   // 注册时间上界（含当日 23:59:59.999 UTC）
  q?: string;           // 用户名关键词
}

/** 'YYYY-MM-DD' → 当日 UTC 00:00 毫秒；空值返回 undefined */
function parseDayStart(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new AppError("bad_param", `${name} 需为 YYYY-MM-DD 格式`, 400);
  }
  const ms = Date.parse(v + "T00:00:00Z");
  if (Number.isNaN(ms)) throw new AppError("bad_param", `${name} 不是有效日期`, 400);
  return ms;
}

/** 校验并归一化筛选条件；日期按 UTC 自然日处理（与库内时间戳约定一致） */
export function parseUserFilter(body: Record<string, unknown>): UserFilter {
  const f: UserFilter = {};

  const role = body.role;
  if (role !== undefined && role !== null && role !== "" && role !== "all") {
    if (role !== "user" && role !== "admin") {
      throw new AppError("bad_param", "角色只能是 user 或 admin", 400);
    }
    f.role = role;
  }

  const optionalInt = (v: unknown, name: string): number | undefined =>
    v === undefined || v === null || v === "" ? undefined : asInt(v, 0, 1_000_000_000, name);
  f.balanceMin = optionalInt(body.balanceMin, "余额下限");
  f.balanceMax = optionalInt(body.balanceMax, "余额上限");

  const from = parseDayStart(body.createdFrom, "注册起始日期");
  const to = parseDayStart(body.createdTo, "注册结束日期");
  if (from !== undefined) f.createdFrom = from;
  // 结束日期含当日整天，否则“截止 9 月 10 日”会把当天注册的人漏掉
  if (to !== undefined) f.createdTo = to + 86_400_000 - 1;

  if (f.balanceMin !== undefined && f.balanceMax !== undefined && f.balanceMin > f.balanceMax) {
    throw new AppError("bad_param", "余额下限不能大于上限", 400);
  }
  if (f.createdFrom !== undefined && f.createdTo !== undefined && f.createdFrom > f.createdTo) {
    throw new AppError("bad_param", "注册起始日期不能晚于结束日期", 400);
  }

  const q = asStr(body.q ?? "", 24, "用户名关键词").toLowerCase();
  if (q) f.q = q;
  return f;
}

/**
 * 条件 → WHERE 片段。片段数量由条件决定但取值全部走参数绑定，
 * 用户输入不进 SQL 文本，无注入面。
 */
function filterWhere(f: UserFilter): { sql: string; binds: (string | number)[] } {
  const clauses: string[] = [];
  const binds: (string | number)[] = [];
  if (f.role) { clauses.push("role = ?"); binds.push(f.role); }
  if (f.balanceMin !== undefined) { clauses.push("balance >= ?"); binds.push(f.balanceMin); }
  if (f.balanceMax !== undefined) { clauses.push("balance <= ?"); binds.push(f.balanceMax); }
  if (f.createdFrom !== undefined) { clauses.push("created_at >= ?"); binds.push(f.createdFrom); }
  if (f.createdTo !== undefined) { clauses.push("created_at <= ?"); binds.push(f.createdTo); }
  if (f.q) {
    clauses.push("username_lower LIKE ? ESCAPE '\\'");
    binds.push(`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  return { sql: clauses.length ? " WHERE " + clauses.join(" AND ") : "", binds };
}

/** 空条件等价于“全部用户”，必须拒绝，否则一次误操作就是全员发分 */
export function isEmptyFilter(f: UserFilter): boolean {
  return (
    !f.role &&
    f.balanceMin === undefined &&
    f.balanceMax === undefined &&
    f.createdFrom === undefined &&
    f.createdTo === undefined &&
    !f.q
  );
}

/** 按条件取出用户 ID；命中为空或超上限都报错，不静默截断 */
async function resolveFilterUserIds(env: Ctx["env"], f: UserFilter): Promise<string[]> {
  const { sql, binds } = filterWhere(f);
  const rows = await env.DB.prepare(
    `SELECT id FROM users${sql} ORDER BY created_at ASC LIMIT ?`
  )
    .bind(...binds, MAX_FILTER_USERS + 1)
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);
  if (ids.length === 0) throw new AppError("no_match", "没有用户符合这些条件", 400);
  if (ids.length > MAX_FILTER_USERS) {
    throw new AppError("too_many", `匹配用户超过 ${MAX_FILTER_USERS} 人，请缩小条件范围`, 400);
  }
  return ids;
}

/** POST /api/admin/users/preview — 预览筛选命中情况（只读，不发放） */
export async function handlePreviewUsers(ctx: Ctx): Promise<Response> {
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const filter = parseUserFilter(body);
  if (isEmptyFilter(filter)) {
    throw new AppError("bad_param", "请至少设置一个筛选条件", 400);
  }
  const { sql, binds } = filterWhere(filter);
  const total = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM users${sql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const count = total?.n ?? 0;
  const sample = await ctx.env.DB.prepare(
    `SELECT id, username, role, balance, created_at FROM users${sql}
     ORDER BY created_at ASC LIMIT 20`
  )
    .bind(...binds)
    .all();
  return json({
    count,
    limit: MAX_FILTER_USERS,
    exceedsLimit: count > MAX_FILTER_USERS,
    sample: sample.results.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      balance: u.balance,
      createdAt: u.created_at,
    })),
  });
}

// ---------------------------------------------------------------------------
// 批量赠送
// ---------------------------------------------------------------------------

export async function handleCreateBulkGrant(ctx: Ctx): Promise<Response> {
  const admin = ctx.user!;
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const amount = asInt(body.amount, 1, 1_000_000, "赠送积分");
  const reason = asStr(body.reason, 200, "原因");
  if (!reason) throw new AppError("bad_param", "原因不能为空", 400);

  // 发放对象有两种来源：显式 ID 列表，或筛选条件。
  // 条件在“发放时”于服务端重新解析，而不是沿用预览结果，
  // 这样发出的人与当时条件完全一致，中间新增的用户也会被覆盖。
  let userIds: string[];
  let filter: UserFilter | null = null;
  if (body.filter !== undefined) {
    filter = parseUserFilter(requireBody<Record<string, unknown>>(body.filter));
    if (isEmptyFilter(filter)) {
      throw new AppError("bad_param", "请至少设置一个筛选条件", 400);
    }
    userIds = await resolveFilterUserIds(ctx.env, filter);
  } else {
    const userIdsRaw = body.userIds;
    if (!Array.isArray(userIdsRaw) || userIdsRaw.length === 0 || userIdsRaw.length > MAX_FILTER_USERS) {
      throw new AppError("bad_param", `userIds 必须是 1-${MAX_FILTER_USERS} 个用户 ID`, 400);
    }
    userIds = [...new Set(userIdsRaw.map((u) => asStr(u, 64, "用户 ID")))];

    // 预校验用户存在，避免 FK 错误信息不友好
    const found = await ctx.env.DB.prepare(
      `SELECT id FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`
    )
      .bind(...userIds)
      .all<{ id: string }>();
    const foundSet = new Set(found.results.map((r) => r.id));
    const missing = userIds.filter((u) => !foundSet.has(u));
    if (missing.length) {
      throw new AppError("user_not_found", `以下用户不存在: ${missing.slice(0, 5).join(", ")}`, 400);
    }
  }

  const batchId = randomId("B");
  const now = nowMs();
  const chunk = 50;
  for (let i = 0; i < userIds.length; i += chunk) {
    const part = userIds.slice(i, i + chunk);
    await ctx.env.DB.batch(
      part.map((uid) =>
        ctx.env.DB.prepare(
          `INSERT INTO bulk_grants (batch_id, user_id, amount, reason, operator_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        ).bind(batchId, uid, amount, reason, admin.id, now)
      )
    );
  }
  // 审计里留下筛选条件，事后能还原“这批分是按什么条件发出去的”
  await audit(ctx.env, admin.id, "bulk_grant.create", "bulk", batchId, {
    count: userIds.length,
    amount,
    reason,
    filter,
  });
  const result = await processBulkGrants(ctx.env, batchId, admin.id);
  return json({ batchId, ...result, matched: userIds.length });
}

export async function handleRetryBulkGrant(ctx: Ctx): Promise<Response> {
  const admin = ctx.user!;
  const batchId = asStr(ctx.params.batch, 64, "批次 ID");
  const exists = await ctx.env.DB.prepare("SELECT 1 FROM bulk_grants WHERE batch_id = ? LIMIT 1").bind(batchId).first();
  if (!exists) throw new AppError("batch_not_found", "批次不存在", 404);
  await audit(ctx.env, admin.id, "bulk_grant.retry", "bulk", batchId, null);
  const result = await processBulkGrants(ctx.env, batchId, admin.id);
  return json({ batchId, ...result });
}

export async function handleListBulkGrants(ctx: Ctx): Promise<Response> {
  const { offset, page, size } = paginate(ctx.url);
  const batchId = ctx.url.searchParams.get("batch");
  const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM bulk_grants").first<{ n: number }>();
  const rows = batchId
    ? await ctx.env.DB.prepare(
        `SELECT batch_id, user_id, amount, reason, operator_id, status, error, created_at, processed_at
         FROM bulk_grants WHERE batch_id = ? ORDER BY created_at DESC, user_id LIMIT ? OFFSET ?`
      )
        .bind(batchId, size, offset)
        .all()
    : await ctx.env.DB.prepare(
        `SELECT batch_id, user_id, amount, reason, operator_id, status, error, created_at, processed_at
         FROM bulk_grants ORDER BY created_at DESC, user_id LIMIT ? OFFSET ?`
      )
        .bind(size, offset)
        .all();
  return json({
    items: rows.results.map((r) => ({
      batchId: r.batch_id,
      userId: r.user_id,
      amount: r.amount,
      reason: r.reason,
      operatorId: r.operator_id,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      processedAt: r.processed_at,
    })),
    page,
    size,
    total: total?.n ?? 0,
  });
}

interface BulkResult {
  succeeded: number;
  failed: number;
  skipped: number;
  remaining: number;
}

/**
 * 处理批次中待处理 / 失败的条目。每条：持租约 → 到期补算 → 入账事务 → 标记结果。
 * 若流水唯一键冲突说明之前已入账（上次标记失败），按成功处理。
 */
async function processBulkGrants(env: Ctx["env"], batchId: string, operatorId: string): Promise<BulkResult> {
  const { acquireCoord, releaseCoord } = await import("./util.js");
  const result: BulkResult = { succeeded: 0, failed: 0, skipped: 0, remaining: 0 };
  for (let round = 0; round < 5; round++) {
    const rows = await env.DB.prepare(
      `SELECT rowid AS rid, batch_id, user_id, amount, reason FROM bulk_grants
       WHERE batch_id = ? AND status IN ('pending', 'failed')
       ORDER BY rowid LIMIT 20`
    )
      .bind(batchId)
      .all<{ rid: number; batch_id: string; user_id: string; amount: number; reason: string }>();
    if (!rows.results.length) break;
    for (const row of rows.results) {
      let token: string;
      try {
        token = await acquireCoord(env.DB, row.user_id);
      } catch {
        result.skipped += 1;
        result.remaining += 1;
        continue;
      }
      try {
        const catchUp = await catchUpUser(env, row.user_id, token);
        if (catchUp.stillDue) throw new Error("settlement_backlog");
        await env.DB.batch([
          creditUserStmt(env.DB, row.user_id, row.amount),
          ledgerStmt(env.DB, row.user_id, row.amount, "bulk", `bulk:${row.batch_id}:${row.user_id}`, row.reason, nowMs()),
          env.DB.prepare(
            `UPDATE bulk_grants SET status = CASE
               WHEN batch_id = ? AND user_id = ? AND status IN ('pending','failed') THEN 'succeeded' ELSE NULL END,
               processed_at = ?, error = NULL
             WHERE batch_id = ? AND user_id = ?`
          ).bind(row.batch_id, row.user_id, nowMs(), row.batch_id, row.user_id),
        ]);
        result.succeeded += 1;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (classifyDbError(e) === "ledger_conflict") {
          // 之前已入账但未标记成功：补标记，不重复赠送
          await env.DB.prepare(
            `UPDATE bulk_grants SET status = 'succeeded', processed_at = ?, error = NULL
             WHERE batch_id = ? AND user_id = ? AND status IN ('pending','failed')`
          )
            .bind(nowMs(), row.batch_id, row.user_id)
            .run();
          result.succeeded += 1;
        } else {
          await env.DB.prepare(
            `UPDATE bulk_grants SET status = 'failed', error = ?, processed_at = ?
             WHERE batch_id = ? AND user_id = ? AND status IN ('pending','failed')`
          )
            .bind(msg.slice(0, 500), nowMs(), row.batch_id, row.user_id)
            .run();
          result.failed += 1;
        }
      } finally {
        await releaseCoord(env.DB, row.user_id, token);
      }
    }
  }
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bulk_grants WHERE batch_id = ? AND status IN ('pending','failed')"
  )
    .bind(batchId)
    .first<{ n: number }>();
  result.remaining = remaining?.n ?? 0;
  void operatorId;
  return result;
}

// ---------------------------------------------------------------------------
// 捐助确认
// ---------------------------------------------------------------------------

export async function handleAdminOrders(ctx: Ctx): Promise<Response> {
  const status = ctx.url.searchParams.get("status");
  const { offset, page, size } = paginate(ctx.url);
  const where = status && ["pending", "confirmed", "cancelled"].includes(status) ? "WHERE status = ?" : "";
  const binds: string[] = status && where ? [status] : [];
  const total = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM donation_orders ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await ctx.env.DB.prepare(
    `SELECT o.id, o.user_id, u.username, o.amount_fen, o.rate_snapshot, o.points, o.status,
            o.channel, o.txn_no, o.confirmed_by, o.confirmed_at, o.created_at
     FROM donation_orders o JOIN users u ON u.id = o.user_id
     ${where}
     ORDER BY o.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, size, offset)
    .all();
  return json({
    items: rows.results.map((o) => ({
      id: o.id,
      userId: o.user_id,
      username: o.username,
      amountFen: o.amount_fen,
      rateSnapshot: o.rate_snapshot,
      points: o.points,
      status: o.status,
      channel: o.channel,
      txnNo: o.txn_no,
      confirmedBy: o.confirmed_by,
      confirmedAt: o.confirmed_at,
      createdAt: o.created_at,
    })),
    page,
    size,
    total: total?.n ?? 0,
  });
}

export async function handleConfirmOrder(ctx: Ctx): Promise<Response> {
  const admin = ctx.user!;
  const orderId = ctx.params.id;
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const channel = asStr(body.channel, 32, "收款渠道");
  const txnNo = asStr(body.txnNo, 128, "到账交易号", false);
  if (!channel) throw new AppError("bad_param", "收款渠道不能为空", 400);
  if (!txnNo) throw new AppError("bad_param", "到账交易号不能为空", 400);

  const order = await ctx.env.DB.prepare(
    "SELECT id, user_id, points, status FROM donation_orders WHERE id = ?"
  )
    .bind(orderId)
    .first<{ id: string; user_id: string; points: number; status: string }>();
  if (!order) throw new AppError("order_not_found", "订单不存在", 404);
  if (order.status === "confirmed") {
    // 重复确认：返回已有结果，不再次发放
    return json({ ok: true, already: true, orderId, points: order.points });
  }
  if (order.status !== "pending") throw new AppError("order_not_pending", "已取消订单不能确认", 409);

  return withCoord(ctx.env, order.user_id, async () => {
    const now = nowMs();
    try {
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `UPDATE donation_orders SET
             status = CASE WHEN id = ? AND status = 'pending' THEN 'confirmed' ELSE NULL END,
             channel = ?, txn_no = ?, confirmed_by = ?, confirmed_at = ?
           WHERE id = ?`
        ).bind(orderId, channel, txnNo, admin.id, now, orderId),
        creditUserStmt(ctx.env.DB, order.user_id, order.points),
        ledgerStmt(
          ctx.env.DB,
          order.user_id,
          order.points,
          "donation",
          `donation:${orderId}`,
          `捐助确认 ${channel} ${txnNo}`,
          now
        ),
      ]);
    } catch (e) {
      const cls = classifyDbError(e);
      if (cls === "txn_used") {
        throw new AppError("txn_used", "该收款渠道的到账交易号已关联其他订单", 409);
      }
      if (cls === "order_guard") {
        // 并发确认：读取最新状态返回
        const latest = await ctx.env.DB.prepare("SELECT status, points FROM donation_orders WHERE id = ?")
          .bind(orderId)
          .first<{ status: string; points: number }>();
        if (latest?.status === "confirmed") return json({ ok: true, already: true, orderId, points: latest.points });
        throw new AppError("order_not_pending", "订单状态已变化", 409);
      }
      throw e;
    }
    await audit(ctx.env, admin.id, "donation.confirm", "order", orderId, { channel, txnNo, points: order.points });
    return json({ ok: true, already: false, orderId, points: order.points });
  });
}

// ---------------------------------------------------------------------------
// 日结 / 清理 / 审计
// ---------------------------------------------------------------------------

export async function handleSettlementRun(ctx: Ctx): Promise<Response> {
  const admin = ctx.user!;
  // 手动日结与 Cron 共用逻辑，只处理已到期（next_billing_date <= date('now')）的内容
  const stats = await runSettlement(ctx.env.DB, 25_000);
  await audit(ctx.env, admin.id, "settlement.run", "settlement", undefined, stats);
  return json({ stats });
}

export async function handleCleanupRun(ctx: Ctx): Promise<Response> {
  const admin = ctx.user!;
  const stats = await cleanupOrphanUploads(ctx.env.DB, ctx.env.UPLOADS);
  // 顺带清理过期会话与速率限制记录
  const now = nowMs();
  await ctx.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await ctx.env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 48 * 3600_000).run();
  await audit(ctx.env, admin.id, "cleanup.run", "uploads", undefined, stats);
  return json({ stats });
}

export async function handleAuditLogs(ctx: Ctx): Promise<Response> {
  const { offset, page, size } = paginate(ctx.url);
  const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs").first<{ n: number }>();
  const rows = await ctx.env.DB.prepare(
    `SELECT id, actor_id, action, object_type, object_id, detail, created_at
     FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  )
    .bind(size, offset)
    .all();
  return json({
    items: rows.results.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      objectType: r.object_type,
      objectId: r.object_id,
      detail: r.detail,
      createdAt: r.created_at,
    })),
    page,
    size,
    total: total?.n ?? 0,
  });
}
