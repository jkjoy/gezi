/**
 * uploads.ts — 图片上传（R2）、图片访问与孤儿对象清理。
 *
 * 安全约束（README）：
 *  * 只接受 JPEG / PNG / WebP，按文件头（magic bytes）判别，拒绝 SVG / HTML 等主动内容；
 *  * 校验实际大小、图片宽高与总像素，限制来自系统配置；
 *  * 对象键由服务端生成并绑定上传者；发布 / 编辑引用时验证归属与 available 状态；
 *  * 返回图片时使用记录中的 Content-Type 并附加 X-Content-Type-Options: nosniff。
 *
 * 跨存储失败处理：D1 与 R2 不共享事务。清理流程先在 D1 原子确认对象无有效引用并置为
 * deleting，再删除 R2 对象，成功后标记 deleted；失败保留 deleting 状态以便重试。
 */
import { AppError, type Ctx, asStr, randomHex, rateLimit, readSettings, requireBody } from "./util.js";

interface ImageInfo {
  mime: string;
  ext: string;
  width: number;
  height: number;
}

function be16(b: Uint8Array, off: number): number {
  return (b[off]! << 8) | b[off + 1]!;
}

function be32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

/** 通过文件头识别图片类型与尺寸；无法识别一律拒绝 */
export function detectImage(b: Uint8Array): ImageInfo | null {
  if (b.length < 12) return null;
  // PNG
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    if (b.length < 24) return null;
    return { mime: "image/png", ext: "png", width: be32(b, 16), height: be32(b, 20) };
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let off = 2;
    while (off + 4 <= b.length) {
      if (b[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = b[off + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = be16(b, off + 2);
      if (
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        if (off + 9 > b.length) return null;
        return { mime: "image/jpeg", ext: "jpg", width: be16(b, off + 7), height: be16(b, off + 5) };
      }
      off += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    if (b.length < 16) return null;
    const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (fourcc === "VP8 ") {
      if (b.length < 30) return null;
      const w = (b[26]! | (b[27]! << 8)) & 0x3fff;
      const h = (b[28]! | (b[29]! << 8)) & 0x3fff;
      return { mime: "image/webp", ext: "webp", width: w, height: h };
    }
    if (fourcc === "VP8L") {
      if (b.length < 26) return null;
      const bits = ((b[22]! | (b[23]! << 8) | (b[24]! << 16) | (b[25]! << 24)) >>> 0);
      return { mime: "image/webp", ext: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8X") {
      if (b.length < 30) return null;
      const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
      const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
      return { mime: "image/webp", ext: "webp", width: w, height: h };
    }
    return null;
  }
  return null;
}

export async function handleUpload(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const env = ctx.env;
  const settings = await readSettings(env);
  await rateLimit(env, `upl:${user.id}`, 20, 3600_000);

  const ct = ctx.req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("multipart/form-data")) {
    throw new AppError("bad_request", "需要 multipart/form-data 上传", 400);
  }
  const contentLength = Number(ctx.req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > settings.uploadMaxBytes + 64 * 1024) {
    throw new AppError("too_large", `文件超过大小限制 (${settings.uploadMaxBytes} 字节)`, 413);
  }

  const form = await ctx.req.formData();
  const file: unknown = form.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
    throw new AppError("bad_request", "缺少文件字段 file", 400);
  }
  const blob = file as File;
  if (blob.size <= 0) throw new AppError("bad_file", "文件为空", 400);
  if (blob.size > settings.uploadMaxBytes) {
    throw new AppError("too_large", `文件超过大小限制 (${settings.uploadMaxBytes} 字节)`, 413);
  }

  const buf = new Uint8Array(await blob.arrayBuffer());
  const info = detectImage(buf);
  if (!info) throw new AppError("unsupported_type", "仅支持 JPEG / PNG / WebP 图片", 415);
  if (info.width < 1 || info.height < 1) throw new AppError("bad_image", "图片尺寸无效", 400);
  if (info.width > settings.uploadMaxWidth || info.height > settings.uploadMaxHeight) {
    throw new AppError(
      "image_too_large",
      `图片尺寸超过限制 (${settings.uploadMaxWidth}×${settings.uploadMaxHeight})`,
      400
    );
  }
  if (info.width * info.height > settings.uploadMaxPixels) {
    throw new AppError("image_too_large", `图片总像素超过限制 (${settings.uploadMaxPixels})`, 400);
  }

  const id = randomHex(12);
  const key = `u/${user.id}/${id}.${info.ext}`;
  await env.UPLOADS.put(key, buf, { httpMetadata: { contentType: info.mime } });
  try {
    await env.DB.prepare(
      `INSERT INTO uploads (id, object_key, owner_id, mime, bytes, width, height, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`
    )
      .bind(id, key, user.id, info.mime, blob.size, info.width, info.height, Date.now())
      .run();
  } catch (e) {
    // 记录失败：删除刚写入的对象，避免无主的 R2 文件
    await env.UPLOADS.delete(key).catch(() => {});
    throw e;
  }
  return json({
    id,
    key,
    mime: info.mime,
    bytes: blob.size,
    width: info.width,
    height: info.height,
    url: `/api/images/${key}`,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// 图片访问
// ---------------------------------------------------------------------------

export async function handleImage(ctx: Ctx): Promise<Response> {
  const key = ctx.params.key;
  if (!/^u\/[A-Za-z0-9]+\/[A-Za-z0-9]+\.(png|jpg|webp)$/.test(key)) {
    return new Response("Not found", { status: 404 });
  }
  const row = await ctx.env.DB.prepare("SELECT mime, status FROM uploads WHERE object_key = ?")
    .bind(key)
    .first<{ mime: string; status: string }>();
  if (!row || row.status !== "available") return new Response("Not found", { status: 404 });
  const obj = await ctx.env.UPLOADS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": row.mime,
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
      "content-disposition": "inline",
    },
  });
}

// ---------------------------------------------------------------------------
// 孤儿对象清理（Cron / 管理员手动触发复用）
// ---------------------------------------------------------------------------

export interface CleanupStats {
  marked: number;
  deleted: number;
  failed: number;
}

export async function cleanupOrphanUploads(
  db: D1Database,
  bucket: R2Bucket,
  limit = 40,
  graceMs = 24 * 3600_000
): Promise<CleanupStats> {
  const stats: CleanupStats = { marked: 0, deleted: 0, failed: 0 };
  const cutoff = Date.now() - graceMs;
  const notReferenced =
    "id NOT IN (SELECT image_upload_id FROM grid_posts WHERE image_upload_id IS NOT NULL AND status = 'active')";

  // 第一步：available → deleting（同一语句内原子确认无有效引用）
  const candidates = await db.prepare(
    `SELECT id, object_key FROM uploads
     WHERE status = 'available' AND created_at < ? AND ${notReferenced}
     LIMIT ?`
  )
    .bind(cutoff, limit)
    .all<{ id: string; object_key: string }>();
  for (const c of candidates.results) {
    const r = await db.prepare(`UPDATE uploads SET status = 'deleting' WHERE id = ? AND status = 'available' AND ${notReferenced}`)
      .bind(c.id)
      .run();
    if (r.meta.changes === 1) stats.marked += 1;
  }

  // 第二步：deleting → 删除 R2 对象 → deleted；失败保留 deleting 供下次重试
  const deleting = await db.prepare("SELECT id, object_key FROM uploads WHERE status = 'deleting' LIMIT ?")
    .bind(limit)
    .all<{ id: string; object_key: string }>();
  for (const d of deleting.results) {
    try {
      await bucket.delete(d.object_key);
      await db.prepare("UPDATE uploads SET status = 'deleted' WHERE id = ?").bind(d.id).run();
      stats.deleted += 1;
    } catch {
      stats.failed += 1;
    }
  }
  return stats;
}

// 供测试断言使用
export const _internal = { requireBody, asStr, randomHex };
