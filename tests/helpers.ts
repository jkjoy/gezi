/**
 * 测试公共工具：注册 / 登录 / 发请求的封装。
 * 每个测试文件通过 setup.ts 在隔离存储上应用迁移。
 */
import { env, SELF } from "cloudflare:test";

export const BASE = "http://localhost";

export interface Session {
  cookie: string;
  user: { id: string; username: string; role: string; balance: number; inviteCode: string };
}

export function jsonReq(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // 模拟同源浏览器请求，通过 CSRF 校验
  if (method !== "GET" && method !== "HEAD") headers.origin = BASE;
  if (cookie) headers.cookie = cookie;
  return SELF.fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function register(username: string, password = "password123"): Promise<Session> {
  const res = await jsonReq("POST", "/api/auth/register", { username, password });
  if (res.status !== 200) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0]!;
  const data = (await res.json()) as { user: Session["user"] };
  return { cookie, user: data.user };
}

export async function login(username: string, password: string): Promise<Session> {
  const res = await jsonReq("POST", "/api/auth/login", { username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0]!;
  const data = (await res.json()) as { user: Session["user"] };
  return { cookie, user: data.user };
}

export async function initAdmin(username = "rootadmin", password = "admin-password-123"): Promise<Session> {
  const res = await jsonReq("POST", "/api/admin/init", {
    token: env.ADMIN_INIT_TOKEN,
    username,
    password,
  });
  // 幂等：初始化入口已关闭（或同名管理员已存在）时直接登录复用
  if (res.status !== 200 && res.status !== 403) {
    throw new Error(`admin init failed: ${res.status} ${await res.text()}`);
  }
  return login(username, password);
}

export async function publish(
  cookie: string,
  input: {
    requestId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    link?: string | null;
    imageId?: string | null;
  }
): Promise<Response> {
  return jsonReq("POST", "/api/posts", input, cookie);
}

export async function getUserRow(userId: string): Promise<{ balance: number } | null> {
  return env.DB.prepare("SELECT balance FROM users WHERE id = ?").bind(userId).first<{ balance: number }>();
}

export async function ledgerSum(userId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM point_ledger WHERE user_id = ?")
    .bind(userId)
    .first<{ s: number }>();
  return r?.s ?? 0;
}

/** 生成最小合法 PNG（1×1），用于上传测试 */
export function tinyPng(): Uint8Array {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b)! & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 1); // width
  dv.setUint32(4, 1); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const iend = chunk("IEND", new Uint8Array(0));
  const idat = chunk(
    "IDAT",
    // zlib: 0x78 0x01 + raw deflate of filter byte + RGB pixel + adler32
    (() => {
      const raw = new Uint8Array([0, 0, 0, 0, 255]);
      const zlib = new Uint8Array(2 + raw.length + 4);
      zlib[0] = 0x78;
      zlib[1] = 0x01;
      zlib.set(raw, 2);
      // adler32
      let a = 1;
      let b = 0;
      for (const byte of raw) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
      }
      const adler = ((b << 16) | a) >>> 0;
      new DataView(zlib.buffer).setUint32(2 + raw.length, adler);
      return zlib;
    })()
  );
  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length + 8 * 2);
  let off = 0;
  png.set(sig, off);
  off += sig.length;
  const ihdrChunk = chunk("IHDR", ihdr);
  png.set(ihdrChunk, off);
  off += ihdrChunk.length;
  png.set(idat, off);
  off += idat.length;
  png.set(iend, off);
  return png.subarray(0, off + iend.length);
}

/** 生成最小合法两帧动画 GIF（8×8），用于 GIF 识别与动画往返测试 */
export function tinyGif(): Uint8Array {
  // GIF89a 签名 + 逻辑屏幕描述符（8x8, GCT 关闭）+ 两个图像描述符 + 结束符
  const parts: number[] = [];
  const push = (...bs: number[]) => parts.push(...bs);
  const pushStr = (t: string) => { for (const c of t) parts.push(c.charCodeAt(0)); };
  pushStr("GIF89a");
  push(8, 0, 8, 0); // 宽高 小端
  push(0x00, 0x00); // 无全局色表，背景 0，比例 0
  // 第一帧：图像描述符 + 最小 LZW 数据
  push(0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0x00); // 图像描述符（无局部色表）
  push(0x02); // LZW 最小码长
  push(0x02, 0x4c, 0x01); // 数据块（clear/end 码）
  push(0x00); // 块结束
  // 第二帧：图形控制扩展 + 图像描述符（动画帧）
  push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00); // GCE: 延时 10ms
  push(0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0x00);
  push(0x02, 0x4c, 0x01, 0x00);
  push(0x3b); // 结束符
  return new Uint8Array(parts);
}

export async function uploadImage(cookie: string, bytes: Uint8Array, filename = "t.png"): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([bytes.slice().buffer as ArrayBuffer], filename, { type: "image/png" }));
  return SELF.fetch(BASE + "/api/uploads", {
    method: "POST",
    headers: { cookie, origin: BASE },
    body: fd,
  });
}

let counter = 0;
export function reqId(): string {
  counter += 1;
  return `req${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
