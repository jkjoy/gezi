/**
 * billing.ts — 每日结算与中断补算（Cron 与管理员手动触发复用）。
 *
 * 规则（README §4）：
 *  * 每条内容按发布时的 D 快照计费，结算键为“内容 ID + 应结算日期”，
 *    daily_settlements 的唯一约束保证 Cron 重试 / 手动触发 / 并发触发不重复扣费；
 *  * 同一用户按“应结算日期、发布时间、内容 ID”排序补算：先处理较早日期的全部内容，
 *    再进入下一日期，不能逐条内容一次补到今天；
 *  * 同一用户同一天按“发布时间、内容 ID”排序，串行处理余额；余额不足时只过期该条，
 *    不扣部分费用，后续条目继续判断；
 *  * 每次扣费与流水、下一次结算日期一起提交；过期状态与格子释放一起提交；
 *  * 调用者必须先持有该用户的协调租约（与发布、删除、入账共享账户协调规则）。
 */
import { classifyDbError, type Env, renewCoord } from "./util.js";

export interface CatchUpResult {
  charged: number;
  expired: number;
  errors: number;
  /** true 表示达到单次处理上限后仍有到期内容 */
  stillDue: boolean;
}

interface DuePost {
  id: string;
  price_d: number;
  width: number;
  height: number;
  next_billing_date: string;
}

/**
 * 补算单个用户的全部到期内容。要求调用者已持有该用户的协调租约，
 * 长循环中会用同一令牌续租。返回 stillDue=true 时调用方应中止依赖当前余额的业务操作。
 */
export async function catchUpUser(env: Env, userId: string, coordToken: string, maxPosts = 300): Promise<CatchUpResult> {
  let charged = 0;
  let expired = 0;
  let errors = 0;
  for (let i = 0; i < maxPosts; i++) {
    const post = await env.DB.prepare(
      `SELECT id, price_d, width, height, next_billing_date FROM grid_posts
       WHERE user_id = ? AND status = 'active' AND next_billing_date <= date('now')
       ORDER BY next_billing_date, created_at, id
       LIMIT 1`
    )
      .bind(userId)
      .first<DuePost>();
    if (!post) return { charged, expired, errors, stillDue: false };

    const r = await settleOneDay(env, userId, post);
    charged += r.charged;
    expired += r.expired;
    if (r.fatal) {
      errors += 1;
      return { charged, expired, errors, stillDue: true };
    }
    // 长循环中续租，防止租约过期后被其他操作接管；续租失败视为被接管，立即停止
    const renewed = await renewCoord(env.DB, userId, coordToken);
    if (!renewed) return { charged, expired, errors: errors + 1, stillDue: true };
  }
  const more = await env.DB.prepare(
    "SELECT 1 FROM grid_posts WHERE user_id = ? AND status = 'active' AND next_billing_date <= date('now') LIMIT 1"
  )
    .bind(userId)
    .first();
  return { charged, expired, errors, stillDue: !!more };
}

async function settleOneDay(
  env: Env,
  userId: string,
  post: DuePost
): Promise<{ charged: number; expired: number; fatal: boolean }> {
  const date = post.next_billing_date;
  // 每日占用费 = 面积 × 每格日价（README §4）
  const amount = post.price_d * post.width * post.height;
  const now = Date.now();

  if (amount === 0) {
    // 免费日费率：只推进结算日期并记录，不产生扣费与流水
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE grid_posts SET next_billing_date = CASE
             WHEN id = ? AND status = 'active' AND next_billing_date = ? THEN date(?, '+1 day')
             ELSE NULL END
           WHERE id = ?`
        ).bind(post.id, date, date, post.id),
        env.DB.prepare(
          "INSERT INTO daily_settlements (post_id, billing_date, amount, result, created_at) VALUES (?, ?, 0, 'charged', ?)"
        ).bind(post.id, date, now),
      ]);
      return { charged: 1, expired: 0, fatal: false };
    } catch (e) {
      if (classifyDbError(e) === "settlement_conflict") return { charged: 0, expired: 0, fatal: false };
      return { charged: 0, expired: 0, fatal: true };
    }
  }

  // 先尝试扣费：余额 CHECK 失败或已结算冲突都会让整个批量事务回滚
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET balance = CASE WHEN id = ? THEN balance - ? ELSE NULL END WHERE id = ?").bind(
        userId,
        amount,
        userId
      ),
      env.DB.prepare(
        `UPDATE grid_posts SET next_billing_date = CASE
           WHEN id = ? AND status = 'active' AND next_billing_date = ? THEN date(?, '+1 day')
           ELSE NULL END
         WHERE id = ?`
      ).bind(post.id, date, date, post.id),
      env.DB.prepare(
        "INSERT INTO daily_settlements (post_id, billing_date, amount, result, created_at) VALUES (?, ?, ?, 'charged', ?)"
      ).bind(post.id, date, amount, now),
      env.DB.prepare(
        `INSERT INTO point_ledger (user_id, amount, balance_after, reason, business_key, note, created_at)
         SELECT ?, ?, balance, 'daily', ?, ?, ? FROM users WHERE id = ?`
      ).bind(userId, -amount, `daily:${post.id}:${date}`, `每日占用 ${date}`, now, userId),
    ]);
    return { charged: 1, expired: 0, fatal: false };
  } catch (e) {
    const cls = classifyDbError(e);
    if (cls === "settlement_conflict") return { charged: 0, expired: 0, fatal: false }; // 并发已结算，跳过
    if (cls !== "balance") return { charged: 0, expired: 0, fatal: true };
    // 余额不足：仅过期该条（不扣部分费用），格子随同释放
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE grid_posts SET status = CASE
             WHEN id = ? AND status = 'active' AND next_billing_date = ? THEN 'expired'
             ELSE NULL END,
             updated_at = ?
           WHERE id = ?`
        ).bind(post.id, date, now, post.id),
        env.DB.prepare("DELETE FROM grid_cells WHERE post_id = ?").bind(post.id),
        env.DB.prepare(
          "INSERT INTO daily_settlements (post_id, billing_date, amount, result, created_at) VALUES (?, ?, 0, 'expired', ?)"
        ).bind(post.id, date, now),
      ]);
      return { charged: 0, expired: 1, fatal: false };
    } catch (e2) {
      if (classifyDbError(e2) === "settlement_conflict") return { charged: 0, expired: 0, fatal: false };
      return { charged: 0, expired: 0, fatal: true };
    }
  }
}

// ---------------------------------------------------------------------------

export interface SettlementStats {
  users: number;
  skipped: number;
  charged: number;
  expired: number;
  errors: number;
  partial: boolean;
}

/**
 * 扫描全部到期内容并按用户逐个补算。分批处理并受时间预算约束，
 * 超出预算返回 partial=true，剩余部分由下一次 Cron / 手动触发继续（幂等）。
 */
export async function runSettlement(db: D1Database, budgetMs = 10 * 60_000): Promise<SettlementStats> {
  const started = Date.now();
  const stats: SettlementStats = { users: 0, skipped: 0, charged: 0, expired: 0, errors: 0, partial: false };
  const { acquireCoord, releaseCoord } = await import("./util.js");
  while (Date.now() - started < budgetMs) {
    const users = await db.prepare(
      `SELECT DISTINCT user_id FROM grid_posts
       WHERE status = 'active' AND next_billing_date <= date('now')
       ORDER BY user_id LIMIT 25`
    ).all<{ user_id: string }>();
    if (!users.results.length) return stats;
    for (const { user_id } of users.results) {
      let token: string;
      try {
        token = await acquireCoord(db, user_id, 3);
      } catch {
        stats.skipped += 1; // 被并发结算或用户自身操作占用，留给下一轮
        continue;
      }
      try {
        const r = await catchUpUser({ DB: db } as Parameters<typeof catchUpUser>[0], user_id, token);
        stats.users += 1;
        stats.charged += r.charged;
        stats.expired += r.expired;
        stats.errors += r.errors;
      } finally {
        await releaseCoord(db, user_id, token);
      }
    }
  }
  stats.partial = true;
  return stats;
}
