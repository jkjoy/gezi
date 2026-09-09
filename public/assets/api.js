/* 公共 API 封装：同域 /api/*，Cookie 会话 */
(function () {
  "use strict";

  async function request(method, path, body, isForm) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      if (isForm) {
        opts.body = body;
      } else {
        opts.headers["content-type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const err = new Error((data && data.message) || "请求失败");
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  window.API = {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    del: (p) => request("DELETE", p),
    upload: (p, formData) => request("POST", p, formData, true),

    /** 安全渲染文本（不解析 HTML） */
    esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
    },

    fmtTime(ms) {
      if (!ms) return "-";
      return new Date(ms).toLocaleString("zh-CN", { hour12: false });
    },

    /** 校验并规范化外链：仅 http/https */
    safeLink(u) {
      if (!u) return null;
      try {
        const url = new URL(u);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.href;
      } catch (_) { return null; }
    },
  };
})();
