-- 0001_init.sql — GeoPixel Wall 初始 schema
-- 约定：
--   * 积分与金额（分）均为非负整数，余额不得透支（见 users 表 CHECK 约束）；
--   * 时间统一为 Unix 毫秒时间戳；日期统一为 UTC 'YYYY-MM-DD' 字符串；
--   * 账户/内容/图片等业务实体主键由服务端生成随机 ID（TEXT），避免自增 ID 泄露规模；
--   * 唯一约束是并发正确性的最后防线：占格冲突、请求去重、日结去重、账本去重都依赖它。

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  balance        INTEGER NOT NULL DEFAULT 0,
  invite_code    TEXT NOT NULL UNIQUE,
  -- 账户写入协调状态：同一账户的余额写操作（发布扣费、日结、入账）先持有租约再执行，
  -- 通过条件 UPDATE 在数据库层面串行化，不依赖单个 Worker 实例的内存锁。
  coord_token    TEXT,
  coord_until    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  CONSTRAINT users_balance_nonnegative CHECK (balance >= 0)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,           -- 仅存令牌 SHA-256 摘要，不存原文
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS point_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  amount        INTEGER NOT NULL CHECK (amount != 0),
  balance_after INTEGER NOT NULL,
  reason        TEXT NOT NULL,           -- register|invite|donation|publish|daily|bulk
  business_key  TEXT NOT NULL,           -- 业务唯一键，配合 UNIQUE 防止重复入账/扣费
  note          TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (user_id, business_key)
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON point_ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS invite_visits (
  id            TEXT PRIMARY KEY,
  inviter_id    TEXT NOT NULL REFERENCES users(id),
  ip_hash       TEXT NOT NULL,           -- HMAC(INVITE_HASH_SECRET, 可信客户端 IP)，不存原始 IP
  reward_amount INTEGER,                 -- 非 NULL 表示已发放奖励；NULL 表示访问未奖励
  created_at    INTEGER NOT NULL,
  UNIQUE (inviter_id, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_invite_inviter_time ON invite_visits(inviter_id, created_at);

CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT PRIMARY KEY,
  object_key  TEXT NOT NULL UNIQUE,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL CHECK (bytes > 0),
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','deleting','deleted')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status, created_at);

CREATE TABLE IF NOT EXISTS donation_orders (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  amount_fen    INTEGER NOT NULL CHECK (amount_fen > 0),   -- 金额以整数“分”保存
  rate_snapshot INTEGER NOT NULL CHECK (rate_snapshot > 0), -- 下单时的兑换率快照
  points        INTEGER NOT NULL CHECK (points > 0),        -- floor(金额分 × R / 100)
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
  channel       TEXT,
  txn_no        TEXT,
  confirmed_by  TEXT,
  confirmed_at  INTEGER,
  created_at    INTEGER NOT NULL,
  -- 同一收款渠道的同一到账交易号只能关联一个订单（NULL 互不冲突）
  UNIQUE (channel, txn_no)
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON donation_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON donation_orders(status, created_at);

CREATE TABLE IF NOT EXISTS grid_posts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  x                 INTEGER NOT NULL,
  y                 INTEGER NOT NULL,
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  text              TEXT NOT NULL DEFAULT '',
  image_upload_id   TEXT REFERENCES uploads(id),
  link              TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','deleted')),
  -- 发布时的费率快照：费率调整只影响新发布内容
  price_p           INTEGER NOT NULL,
  price_d           INTEGER NOT NULL,
  next_billing_date TEXT NOT NULL,
  request_id        TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  last_result       TEXT,                -- 成功结果快照，用于同请求 ID 重试时返回原结果
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (user_id, request_id),
  CONSTRAINT posts_rect_valid CHECK (
    x >= 0 AND y >= 0 AND width >= 1 AND height >= 1
    AND x + width <= 100 AND y + height <= 100
  )
);
CREATE INDEX IF NOT EXISTS idx_posts_billing ON grid_posts(status, next_billing_date);
CREATE INDEX IF NOT EXISTS idx_posts_user_created ON grid_posts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_image ON grid_posts(image_upload_id);

CREATE TABLE IF NOT EXISTS grid_cells (
  x       INTEGER NOT NULL,
  y       INTEGER NOT NULL,
  post_id TEXT NOT NULL REFERENCES grid_posts(id) ON DELETE CASCADE,
  PRIMARY KEY (x, y)                     -- 数据库层面阻止同一坐标被重复占用
);
CREATE INDEX IF NOT EXISTS idx_cells_post ON grid_cells(post_id);

CREATE TABLE IF NOT EXISTS daily_settlements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      TEXT NOT NULL REFERENCES grid_posts(id),
  billing_date TEXT NOT NULL,
  amount       INTEGER NOT NULL,         -- 实际扣费；过期条目为 0
  result       TEXT NOT NULL CHECK (result IN ('charged','expired')),
  created_at   INTEGER NOT NULL,
  UNIQUE (post_id, billing_date)         -- 同一内容同一天最多结算一次（Cron 重试 / 手动触发安全）
);
CREATE INDEX IF NOT EXISTS idx_settlements_date ON daily_settlements(billing_date);

CREATE TABLE IF NOT EXISTS bulk_grants (
  batch_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  reason       TEXT NOT NULL,
  operator_id  TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  error        TEXT,
  created_at   INTEGER NOT NULL,
  processed_at INTEGER,
  PRIMARY KEY (batch_id, user_id)        -- 每个批次对同一用户只发一次
);
CREATE INDEX IF NOT EXISTS idx_bulk_status ON bulk_grants(status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT,                      -- 可为 NULL（系统动作）
  action      TEXT NOT NULL,
  object_type TEXT,
  object_id   TEXT,
  detail      TEXT,                      -- JSON 摘要；禁止记录密码、令牌或完整 IP
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,         -- 例如 login:{ip}、pub:{userId}、inv:{ipHash}
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- 默认配置（管理员可在后台调整；仅影响之后的操作，不回溯既有快照）
INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES
  ('publish_price_p',   '2',        0),   -- 每格一次性发布价格
  ('daily_price_d',     '1',        0),   -- 每格每日占用价格
  ('register_reward',   '200',      0),   -- 注册奖励（每个账户一次）
  ('invite_reward',     '20',       0),   -- 邀请奖励（每次合格首访）
  ('invite_daily_cap',  '5',        0),   -- 每位邀请人每日邀请奖励上限
  ('exchange_rate',     '100',      0),   -- 每元兑换积分数 R
  ('donation_min_fen',  '100',      0),   -- 捐助订单最低金额（分）
  ('upload_max_bytes',  '2097152',  0),   -- 单张图片最大 2 MiB
  ('upload_max_width',  '1024',     0),
  ('upload_max_height', '1024',     0),
  ('upload_max_pixels', '1048576',  0),   -- 总像素上限
  ('session_ttl_hours', '168',      0),   -- 会话有效期 7 天
  ('admin_initialized', '0',        0)    -- 一次性管理员初始化入口开关
;
