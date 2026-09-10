/**
 * posts.ts — 像素墙内容的发布、编辑、删除与格子占用。
 *
 * 原子性（README §3）：
 *  * 内容记录、格子占用、余额扣减、积分流水在同一个 D1 batch（单事务）中提交，
 *    任何一步失败整体回滚：不出现“扣费未发布”或“发布未扣费”；
 *  * 格子占用用一条递归 CTE 一次性插入 w×h 个坐标，唯一主键阻止重复占用，
 *    全墙 10,000 格也能在语句/参数限制内原子完成；
 *  * 请求按“用户 ID + 请求 ID”去重并保存请求摘要与成功结果，重试返回原结果，
 *    同一请求 ID 携带不同内容时拒绝；
 *  * 发布 / 编辑 / 删除前先持租约并完成到期补算，逾期内容不能靠这些操作绕过费用。
 */
import {
  AppError,
  type Ctx,
  GRID,
  LINK_MAX,
  TEXT_MAX,
  REQUEST_ID_RE,
  asInt,
  asStr,
  classifyDbError,
  json,
  nowMs,
  randomId,
  rateLimit,
  readJson,
  readSettings,
  requireBody,
  sha256Hex,
} from "./util.js";
import { catchUpUser } from "./billing.js";
import { debitUserStmt, ledgerStmt } from "./util.js";

interface PostRow {
  id: string;
  user_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  image_upload_id: string | null;
  link: string | null;
  status: string;
  price_p: number;
  price_d: number;
  next_billing_date: string;
  request_id: string;
  request_hash: string;
  last_result: string | null;
  created_at: number;
  updated_at: number;
}

export interface PublishInput {
  requestId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  link: string | null;
  imageId: string | null;
}

function validateLink(link: string | null): string | null {
  if (link === null || link === "") return null;
  if (!/^https?:\/\/\S+$/.test(link)) {
    throw new AppError("bad_link", "链接必须以 http:// 或 https:// 开头", 400);
  }
  return link;
}

function validateContent(text: string, imageId: string | null): void {
  if (!text.trim() && !imageId) {
    throw new AppError("empty_content", "内容至少包含文字或图片", 400);
  }
}

/** 归一化发布参数并校验边界，返回可直接入库的字段 */
export function parsePublishInput(body: Record<string, unknown>): PublishInput {
  const requestId = asStr(body.requestId, 64, "请求 ID", false);
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new AppError("bad_request_id", "请求 ID 需为 8-64 位字母、数字、下划线或连字符", 400);
  }
  const x = asInt(body.x, 0, GRID - 1, "x");
  const y = asInt(body.y, 0, GRID - 1, "y");
  const width = asInt(body.width, 1, GRID - x, "width");
  const height = asInt(body.height, 1, GRID - y, "height");
  const text = body.text === undefined || body.text === null ? "" : asStr(body.text, TEXT_MAX, "文字");
  const linkRaw = body.link === undefined || body.link === null ? "" : asStr(body.link, LINK_MAX, "链接");
  const link = validateLink(linkRaw);
  const imageId =
    body.imageId === undefined || body.imageId === null || body.imageId === "" ? null : asStr(body.imageId, 64, "图片 ID");
  validateContent(text, imageId);
  return { requestId, x, y, width, height, text, link, imageId };
}

function publishResponse(row: PostRow, replayed: boolean): Record<string, unknown> {
  return {
    post: {
      id: row.id,
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      text: row.text,
      link: row.link,
      imageId: row.image_upload_id,
      status: row.status,
      createdAt: row.created_at,
    },
    replayed,
  };
}

export async function handlePublish(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const env = ctx.env;
  const input = parsePublishInput(requireBody<Record<string, unknown>>(await readJson(ctx.req)));
  await rateLimit(env, `pub:${user.id}`, 30, 3600_000);

  const settings = await readSettings(env);
  const area = input.width * input.height;
  const fee = area * settings.publishPriceP;
  const dailyFee = area * settings.dailyPriceD;
  const now = nowMs();

  // 请求摘要：同一请求 ID 必须携带相同内容才能重试
  const requestHash = await sha256Hex(
    JSON.stringify([input.x, input.y, input.width, input.height, input.text, input.link, input.imageId])
  );

  // 幂等预检：网络超时后用原请求 ID 重试时返回原结果
  const existing = await env.DB.prepare(
    "SELECT * FROM grid_posts WHERE user_id = ? AND request_id = ?"
  )
    .bind(user.id, input.requestId)
    .first<PostRow>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError("request_conflict", "该请求 ID 已被其他内容使用", 409);
    }
    return json(publishResponse(existing, true));
  }

  // 图片归属与可用性预检（批量事务内还有二次防护）
  let imageKey: string | null = null;
  if (input.imageId) {
    const upload = await env.DB.prepare(
      "SELECT id, object_key FROM uploads WHERE id = ? AND owner_id = ? AND status = 'available'"
    )
      .bind(input.imageId, user.id)
      .first<{ id: string; object_key: string }>();
    if (!upload) throw new AppError("image_unavailable", "图片不存在或不可引用", 400);
    imageKey = upload.object_key;
  }

  const { acquireCoord, releaseCoord } = await import("./util.js");
  const coordToken = await acquireCoord(env.DB, user.id);
  try {
    // 到期补算先行：可能扣减余额、过期内容并释放格子
    const catchUp = await catchUpUser(env, user.id, coordToken);
    if (catchUp.stillDue) throw new AppError("settlement_backlog", "账户存在未完成的到期结算，请稍后重试", 503);

    const balance = await env.DB.prepare("SELECT balance FROM users WHERE id = ?").bind(user.id).first<{ balance: number }>();
    if ((balance?.balance ?? 0) < fee) {
      throw new AppError("insufficient_balance", `余额不足，发布需要 ${fee} 积分`, 400);
    }

    const postId = randomId("p");
    const lastResult = JSON.stringify({
      postId,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      fee,
      dailyFee,
    });

    const stmts: D1PreparedStatement[] = [];
    if (input.imageId) {
      // 在同一事务内确认图片仍可用且属于当前用户：不可用时置 NULL 触发约束失败并回滚
      stmts.push(
        env.DB.prepare(
          `UPDATE uploads SET status = CASE
             WHEN id = ? AND owner_id = ? AND status = 'available' THEN 'available'
             ELSE NULL END
           WHERE id = ?`
        ).bind(input.imageId, user.id, input.imageId)
      );
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO grid_posts
           (id, user_id, x, y, width, height, text, image_upload_id, link, status,
            price_p, price_d, next_billing_date, request_id, request_hash, last_result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, date('now', '+1 day'), ?, ?, ?, ?, ?)`
      ).bind(
        postId,
        user.id,
        input.x,
        input.y,
        input.width,
        input.height,
        input.text,
        input.imageId,
        input.link,
        settings.publishPriceP,
        settings.dailyPriceD,
        input.requestId,
        requestHash,
        lastResult,
        now,
        now
      )
    );
    // 一条递归 CTE 插入全部占用坐标（10,000 格也在单语句内完成）
    stmts.push(
      env.DB.prepare(
        `WITH RECURSIVE
           xs(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM xs WHERE i < ? - 1),
           ys(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM ys WHERE j < ? - 1)
         INSERT INTO grid_cells (x, y, post_id)
         SELECT ? + xs.i, ? + ys.j, ? FROM xs, ys`
      ).bind(input.width, input.height, input.x, input.y, postId)
    );
    if (fee > 0) stmts.push(debitUserStmt(env.DB, user.id, fee));
    if (fee > 0) {
      stmts.push(
        ledgerStmt(env.DB, user.id, -fee, "publish", `publish:${postId}`, `发布 ${input.width}×${input.height} 区域`, now)
      );
    }

    try {
      await env.DB.batch(stmts);
    } catch (e) {
      const cls = classifyDbError(e);
      if (cls === "cells_conflict") {
        throw new AppError("area_conflict", "所选区域已被占用，请重新选择", 409);
      }
      if (cls === "balance") {
        throw new AppError("insufficient_balance", `余额不足，发布需要 ${fee} 积分`, 400);
      }
      if (cls === "upload_guard") {
        throw new AppError("image_unavailable", "图片不存在或不可引用", 400);
      }
      if (cls === "post_request_conflict") {
        // 并发携带同一请求 ID：视为重试，返回已保存的结果
        const row = await env.DB.prepare("SELECT * FROM grid_posts WHERE user_id = ? AND request_id = ?")
          .bind(user.id, input.requestId)
          .first<PostRow>();
        if (row && row.request_hash === requestHash) return json(publishResponse(row, true));
        throw new AppError("request_conflict", "该请求 ID 已被其他内容使用", 409);
      }
      if (cls === "ledger_conflict") {
        // 同一内容扣费流水已存在：发布不可能成功两次，按冲突处理
        throw new AppError("internal", "发布冲突，请刷新后重试", 500);
      }
      throw e;
    }

    const row = await env.DB.prepare("SELECT * FROM grid_posts WHERE id = ?").bind(postId).first<PostRow>();
    if (!row) throw new AppError("internal", "发布结果读取失败", 500);
    return json({ ...publishResponse(row, false), image: imageKey ? { key: imageKey } : null });
  } finally {
    await releaseCoord(env.DB, user.id, coordToken);
  }
}

// ---------------------------------------------------------------------------
// 编辑 / 删除
// ---------------------------------------------------------------------------

export async function handleEditPost(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const env = ctx.env;
  const postId = ctx.params.id;
  const body = requireBody<Record<string, unknown>>(await readJson(ctx.req));
  const hasText = body.text !== undefined;
  const hasLink = body.link !== undefined;
  const hasImage = body.imageId !== undefined;
  if (!hasText && !hasLink && !hasImage) {
    throw new AppError("bad_request", "没有需要修改的字段", 400);
  }
  const text = hasText ? asStr(body.text, TEXT_MAX, "文字") : null;
  const link = hasLink ? validateLink(asStr(body.link, LINK_MAX, "链接")) : null;
  const imageId = hasImage && body.imageId !== null && body.imageId !== "" ? asStr(body.imageId, 64, "图片 ID") : null;
  if (hasImage && !imageId) {
    throw new AppError("bad_param", "图片 ID 不能为空字符串", 400);
  }

  const current = await env.DB.prepare("SELECT * FROM grid_posts WHERE id = ?").bind(postId).first<PostRow>();
  if (!current) throw new AppError("post_not_found", "内容不存在", 404);
  if (current.user_id !== user.id) throw new AppError("forbidden", "只能编辑自己的内容", 403);
  if (current.status !== "active") throw new AppError("not_active", "内容已过期或删除，不能编辑", 409);

  const newText = hasText ? text! : current.text;
  const newImageId = hasImage ? imageId! : current.image_upload_id;
  validateContent(newText, newImageId);

  const { acquireCoord, releaseCoord } = await import("./util.js");
  const coordToken = await acquireCoord(env.DB, user.id);
  try {
    // 到期补算可能直接过期该内容；编辑不改变位置、面积与计费快照
    const catchUp = await catchUpUser(env, user.id, coordToken);
    if (catchUp.stillDue) throw new AppError("settlement_backlog", "账户存在未完成的到期结算，请稍后重试", 503);

    const stmts: D1PreparedStatement[] = [];
    if (hasImage && imageId && imageId !== current.image_upload_id) {
      stmts.push(
        env.DB.prepare(
          `UPDATE uploads SET status = CASE
             WHEN id = ? AND owner_id = ? AND status = 'available' THEN 'available'
             ELSE NULL END
           WHERE id = ?`
        ).bind(imageId, user.id, imageId)
      );
    }
    stmts.push(
      env.DB.prepare(
        `UPDATE grid_posts SET
           text = CASE WHEN user_id = ? AND status = 'active' THEN ? ELSE NULL END,
           link = ?,
           image_upload_id = ?,
           updated_at = ?
         WHERE id = ?`
      ).bind(user.id, newText, hasLink ? link : current.link, newImageId, nowMs(), postId)
    );
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      if (classifyDbError(e) === "upload_guard") throw new AppError("image_unavailable", "图片不存在或不可引用", 400);
      if (classifyDbError(e) === "post_guard") throw new AppError("not_active", "内容已过期或删除，不能编辑", 409);
      throw e;
    }
  } finally {
    await releaseCoord(env.DB, user.id, coordToken);
  }

  const row = await env.DB.prepare("SELECT * FROM grid_posts WHERE id = ?").bind(postId).first<PostRow>();
  if (!row) throw new AppError("post_not_found", "内容不存在", 404);
  return json({ post: postView(row, true) });
}

export async function handleDeletePost(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const env = ctx.env;
  const postId = ctx.params.id;

  const current = await env.DB.prepare("SELECT * FROM grid_posts WHERE id = ?").bind(postId).first<PostRow>();
  if (!current) throw new AppError("post_not_found", "内容不存在", 404);
  if (current.user_id !== user.id) throw new AppError("forbidden", "只能删除自己的内容", 403);
  if (current.status !== "active") throw new AppError("not_active", "内容已过期或删除", 409);

  const { acquireCoord, releaseCoord } = await import("./util.js");
  const coordToken = await acquireCoord(env.DB, user.id);
  try {
    // 到期补算先行：不能通过删除绕过已到期的占用费用
    const catchUp = await catchUpUser(env, user.id, coordToken);
    if (catchUp.stillDue) throw new AppError("settlement_backlog", "账户存在未完成的到期结算，请稍后重试", 503);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE grid_posts SET status = CASE
             WHEN user_id = ? AND status = 'active' THEN 'deleted' ELSE NULL END,
             updated_at = ?
           WHERE id = ?`
        ).bind(user.id, nowMs(), postId),
        env.DB.prepare("DELETE FROM grid_cells WHERE post_id = ?").bind(postId),
      ]);
    } catch (e) {
      if (classifyDbError(e) === "post_guard") throw new AppError("not_active", "内容已过期或删除", 409);
      throw e;
    }
  } finally {
    await releaseCoord(env.DB, user.id, coordToken);
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function postView(row: PostRow, own: boolean): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: row.id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    text: row.text,
    link: row.link,
    imageId: row.image_upload_id,
    status: row.status,
    createdAt: row.created_at,
  };
  if (own) {
    view.priceP = row.price_p;
    view.priceD = row.price_d;
    view.nextBillingDate = row.next_billing_date;
    view.updatedAt = row.updated_at;
  }
  return view;
}

export async function handleWall(ctx: Ctx): Promise<Response> {
  const rows = await ctx.env.DB.prepare(
    `SELECT p.id, p.x, p.y, p.width, p.height, p.text, p.link, p.created_at, u.object_key AS image_key
     FROM grid_posts p
     LEFT JOIN uploads u ON u.id = p.image_upload_id AND u.status = 'available'
     WHERE p.status = 'active'
     ORDER BY p.created_at ASC`
  ).all<{ id: string; x: number; y: number; width: number; height: number; text: string; link: string | null; created_at: number; image_key: string | null }>();
  return json({
    grid: GRID,
    cellPx: 10,
    posts: rows.results.map((r) => ({
      id: r.id,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      text: r.text,
      link: r.link, // 发布/编辑时已限制为 http/https；前端打开前再校验一次
      image: r.image_key ? `/api/images/${r.image_key}` : null,
      createdAt: r.created_at,
    })),
  });
}

export async function handlePostDetail(ctx: Ctx): Promise<Response> {
  const row = await ctx.env.DB.prepare(
    `SELECT p.*, u.username AS owner_name, up.object_key AS image_key
     FROM grid_posts p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN uploads up ON up.id = p.image_upload_id AND up.status = 'available'
     WHERE p.id = ?`
  )
    .bind(ctx.params.id)
    .first<PostRow & { owner_name: string; image_key: string | null }>();
  if (!row) throw new AppError("post_not_found", "内容不存在", 404);
  const view = postView(row, false);
  return json({
    post: {
      ...view,
      owner: row.owner_name,
      image: row.image_key ? `/api/images/${row.image_key}` : null,
    },
  });
}

export async function handleMyPosts(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const rows = await ctx.env.DB.prepare(
    "SELECT * FROM grid_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 500"
  )
    .bind(user.id)
    .all<PostRow>();
  return json({ items: rows.results.map((r) => postView(r, true)) });
}
