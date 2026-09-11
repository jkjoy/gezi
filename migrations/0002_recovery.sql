-- 0002_recovery.sql — 账户恢复码
-- 每个用户存恢复码的 SHA-256 哈希（不存明文），用于忘记密码时自助重置。
-- 已有用户该列为 NULL：等效于“未设置恢复码”，找回时返回统一错误，不泄露账户状态。
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
