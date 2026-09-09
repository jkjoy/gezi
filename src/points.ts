/**
 * points.ts — 积分流水、邀请奖励与捐助订单。
 *
 * 入账规则（README §4-5）：
 *  * 每次入账前先补算该账户的到期内容，逾期内容不能靠后续充值恢复；
 *  * 邀请奖励以 (inviter_id, ip_hash) 唯一约束去重，且受每位邀请人每日上限约束，
 *    合格首访至多奖励一次，全部判定在同一批量事务内完成；
 *  * 捐助订单创建不加分，管理员确认到账后一次性入账；重复确认返回已有结果。
 */
import {
  AppError,
  type Ctx,
  asInt,
  asStr,
  classifyDbError,
  hmacHex,
  json,
  nowMs,
  paginate,
  randomId,
  rateLimit,
  readJson,
  readSettings,
  requireBody,
  trustedClientIp,
  utcDayStartMs,
} from "./util.js";
import { catchUpUser } from "./billing.js";
import { mustGetUser } from "./auth.js";

/** 账户入账的公共流程：持租约 → 到期补算 → 入账事务 → 释放 */
async function withCoord<T>(env: Ctx["env"], userId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const { acquireCoord, releaseCoord } = await import("./util.js");
  const token = await acquireCoord(env.DB, userId);
  try {
    const catchUp = await catchUpUser(env, userId, token);
    if (catchUp.stillDue) throw new AppError("settlement_backlog", "账户存在未完成的到期结算，请稍后重试", 503);
    return await fn(token);
  } finally {
    await releaseCoord(env.DB, userId, token);
  }
}

// ---------------------------------------------------------------------------
// 邀请奖励
// ---------------------------------------------------------------------------

export async function handleInviteVisit(ctx: Ctx): Promise<Response> {
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const code = asStr(body.code, 32, "邀请码");
  const env = ctx.env;

  const inviter = await env.DB.prepare("SELECT id FROM users WHERE invite_code = ?").bind(code).first<{ id: string }>();
  if (!inviter) return jsonRewarded(false, "invalid_code");
  // 已登录用户访问自己的邀请链接不奖励
  if (ctx.user && ctx.user.id === inviter.id) return jsonRewarded(false, "self");

  const ip = trustedClientIp(ctx.req);
  if (!ip) return jsonRewarded(false, "no_ip");
  const ipHash = await hmacHex(env.INVITE_HASH_SECRET, ip);
  // 限制单个 IP 高频扫描不同邀请码
  await rateLimit(env, `inv:${ipHash}`, 30, 3600_000);

  const settings = await readSettings(env);
  if (settings.inviteReward <= 0 || settings.inviteDailyCap <= 0) return jsonRewarded(false, "disabled");

  return withCoord(env, inviter.id, async () => {
    const vid = randomId("iv");
    const now = nowMs();
    const dayStart = utcDayStartMs(now);
    // 单条批量事务完成全部判定：
    //  1) 仅当“该邀请人今日奖励数 < 上限”时插入访问记录（唯一约束挡住重复 IP）；
    //  2) 余额入账与流水都以“访问记录已奖励”为条件，未奖励时全部空转。
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO invite_visits (id, inviter_id, ip_hash, reward_amount, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM invite_visits
                  WHERE inviter_id = ? AND reward_amount IS NOT NULL AND created_at >= ?) < ?`
        ).bind(vid, inviter.id, ipHash, settings.inviteReward, now, inviter.id, dayStart, settings.inviteDailyCap),
        env.DB.prepare(
          `UPDATE users SET balance = CASE WHEN id = ? THEN balance + ? ELSE NULL END
           WHERE id = ? AND EXISTS (SELECT 1 FROM invite_visits WHERE id = ? AND reward_amount IS NOT NULL)`
        ).bind(inviter.id, settings.inviteReward, inviter.id, vid),
        env.DB.prepare(
          `INSERT INTO point_ledger (user_id, amount, balance_after, reason, business_key, note, created_at)
           SELECT ?, ?, balance, 'invite', ?, ?, ? FROM users WHERE id = ?
           AND EXISTS (SELECT 1 FROM invite_visits WHERE id = ? AND reward_amount IS NOT NULL)`
        ).bind(inviter.id, settings.inviteReward, `invite:${vid}`, "邀请奖励", now, inviter.id, vid),
      ]);
    } catch (e) {
      if (classifyDbError(e) === "invite_pair_conflict") return jsonRewarded(false, "already_rewarded");
      throw e;
    }
    const visit = await env.DB.prepare("SELECT reward_amount FROM invite_visits WHERE id = ?").bind(vid).first<{
      reward_amount: number | null;
    }>();
    return visit?.reward_amount != null ? jsonRewarded(true) : jsonRewarded(false, "daily_cap");
  });
}

function jsonRewarded(rewarded: boolean, reason?: string): Response {
  return json({ rewarded, reason: rewarded ? undefined : reason });
}

// ---------------------------------------------------------------------------
// 捐助订单（用户侧）
// ---------------------------------------------------------------------------

export async function handleCreateOrder(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const settings = await readSettings(ctx.env);
  const amountFen = asInt(body.amountFen, 1, 100_000_000, "捐助金额");
  if (amountFen < settings.donationMinFen) {
    throw new AppError("amount_too_small", `捐助金额不能低于 ${(settings.donationMinFen / 100).toFixed(2)} 元`, 400);
  }
  const points = Math.floor((amountFen * settings.exchangeRate) / 100);
  if (points <= 0) throw new AppError("amount_too_small", "捐助金额太小，兑换积分为 0", 400);

  await rateLimit(ctx.env, `order:${user.id}`, 10, 3600_000);
  const id = randomId("D");
  const now = nowMs();
  await ctx.env.DB.prepare(
    `INSERT INTO donation_orders (id, user_id, amount_fen, rate_snapshot, points, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(id, user.id, amountFen, settings.exchangeRate, points, now)
    .run();
  return json({ order: { id, amountFen, rateSnapshot: settings.exchangeRate, points, status: "pending", createdAt: now } });
}

export async function handleCancelOrder(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const id = ctx.params.id;
  const order = await ctx.env.DB.prepare("SELECT id, status FROM donation_orders WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first<{ id: string; status: string }>();
  if (!order) throw new AppError("order_not_found", "订单不存在", 404);
  if (order.status !== "pending") throw new AppError("order_not_pending", "仅待确认订单可以取消", 409);
  const r = await ctx.env.DB.prepare(
    `UPDATE donation_orders SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE NULL END WHERE id = ?`
  )
    .bind(id)
    .run();
  if (r.meta.changes !== 1) throw new AppError("order_not_pending", "仅待确认订单可以取消", 409);
  return json({ ok: true });
}

export async function handleListOrders(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const { offset, page, size } = paginate(ctx.url);
  const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM donation_orders WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();
  const items = await ctx.env.DB.prepare(
    `SELECT id, amount_fen, rate_snapshot, points, status, channel, txn_no, created_at, confirmed_at
     FROM donation_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(user.id, size, offset)
    .all();
  return json({
    items: items.results.map((o) => ({
      id: o.id,
      amountFen: o.amount_fen,
      rateSnapshot: o.rate_snapshot,
      points: o.points,
      status: o.status,
      channel: o.channel,
      txnNo: o.txn_no,
      createdAt: o.created_at,
      confirmedAt: o.confirmed_at,
    })),
    page,
    size,
    total: total?.n ?? 0,
  });
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

export async function handleListLedger(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const { offset, page, size } = paginate(ctx.url);
  const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM point_ledger WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();
  const items = await ctx.env.DB.prepare(
    `SELECT id, amount, balance_after, reason, note, created_at
     FROM point_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  )
    .bind(user.id, size, offset)
    .all();
  return json({
    items: items.results.map((l) => ({
      id: l.id,
      amount: l.amount,
      balanceAfter: l.balance_after,
      reason: l.reason,
      note: l.note,
      createdAt: l.created_at,
    })),
    page,
    size,
    total: total?.n ?? 0,
  });
}

// 导出供内部复用
export { withCoord, mustGetUser };
