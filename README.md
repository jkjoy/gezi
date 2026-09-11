# GeoPixel Wall · 公共像素墙

一个参考“百万格子”模式的公共像素墙：用户用积分占用矩形区域，展示文字、图片与链接；持续占用需要每日支付积分，余额不足时自动释放位置，让有限的展示空间持续流转。

基于 Cloudflare Workers + D1 + R2 + Cron Triggers 前后端一体部署，适合个人站点与小型社区。

> **当前状态：已实现并部署。** 账户、积分、像素墙闭环、日结、运营与管理功能均已完成；`npm run check`（类型检查）与 `npm test`（43 个集成测试）通过，`wrangler deploy --dry-run` 打包成功，并已部署到 Cloudflare。详细验收记录见 [`docs/review.md`](docs/review.md)。

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [核心设计](#核心设计)
- [数据模型](#数据模型)
- [API 一览](#api-一览)
- [本地开发](#本地开发)
- [部署到 Cloudflare](#部署到-cloudflare)
- [管理员账号](#管理员账号)
- [系统配置](#系统配置)
- [测试](#测试)
- [安全说明](#安全说明)
- [已知限制与后续计划](#已知限制与后续计划)

---

## 功能特性

**像素墙**
- 默认 `100 × 100` 共 `10,000` 格；每格对应 `10 × 10` 逻辑像素，整墙 `1,000 × 1,000` 逻辑像素。
- Pointer Events 拖选矩形区域（支持反向拖选、Esc 取消、坐标键盘输入），实时预览面积与费用。
- 内容至少含文字或图片，可附 `http/https` 跳转链接。
- **文字自适应**：用 canvas 测量折行（中文逐字、英文按词），二分查找“能完整显示的最大字号”；发布面板给出等比预览与“完整显示所需格数”推荐，一键应用。
- **交互**：内容块文字随区域等比缩放；点击带链接的块直接新窗口打开（`noopener noreferrer`）；悬停显示完整信息浮层（全文、位置尺寸、链接）。

**账户与积分**
- 注册、登录、退出；PBKDF2 密码哈希 + 独立随机盐，数据库随机会话令牌（仅存摘要），`HttpOnly` Cookie。
- 积分来源：注册奖励、邀请奖励、捐助入账、管理员批量赠送。
- `point_ledger` 不可变账本，与 `users.balance` 快照可对账（初始为零 + 全部流水 = 当前余额）。

**发布生命周期**
- 发布 = 内容记录 + 格子占用 + 余额扣减 + 积分流水，同一 D1 事务原子提交；区域冲突返回 `409`，余额不足返回业务错误。
- 客户端生成业务请求 ID，服务端按“用户 + 请求 ID”去重，重试返回原结果，改内容拒绝。
- 编辑只改文字/图片/链接，不动位置、面积与计费快照；删除/过期释放格子、保留历史账本、不退款。

**每日结算（Cron）**
- 按 UTC 自然日结算，`00:00 UTC`（北京时间 08:00）触发；发布当日只收发布费，首次日费在次日日界线。
- 以“内容 ID + 结算日期”为唯一业务键，Cron 重试 / 手动触发 / 并发触发均不重复扣费。
- 停机跨多日按“结算日期、发布时间、内容 ID”全局补算；余额不足只过期该条、不部分扣费；账户写操作前先完成到期补算，逾期内容不能靠充值恢复或删除绕过。

**图片上传**
- 支持 JPEG / PNG / WebP / **GIF（含动画）**；按文件头（magic bytes）识别并解析尺寸，拒绝 SVG / HTML 等主动内容。
- 校验实际大小、宽高与总像素；对象键由服务端生成并绑定上传者；返回 `Content-Type` + `X-Content-Type-Options: nosniff`。
- 动画 GIF 原始字节流直存 R2，浏览器原生播放全部帧。
- 孤儿对象两阶段延迟清理（`available → deleting → deleted`），不误删被有效内容引用的图片。

**邀请奖励**
- `?ref=邀请码`；用独立密钥对可信客户端 IP 做 HMAC 去重（不存原始 IP），`(inviter_id, ip_hash)` 唯一约束。
- 忽略无效码、自邀、无可信 IP；每位邀请人每日奖励上限；生产只信任 Cloudflare 提供的客户端 IP。

**管理后台**
- 系统配置调整、用户搜索、批量赠送积分（批次去重、可重试）、捐助订单确认（单向状态转换、交易号去重、幂等）、手动日结、孤儿图片清理、审计日志。

**前端**
- 原生 HTML/CSS/JS，无框架依赖；内联 Phosphor 图标（Cloudflare kumo 组件库的图标来源）；统一模态窗组件（编辑/删除确认）；未登录后台仅显示登录卡。

---

## 技术栈

| 层次 | 技术 |
| --- | --- |
| 运行时 | Cloudflare Workers（`fetch` + `scheduled` 入口） |
| 语言 | TypeScript 5.8（`tsc --noEmit` 严格类型检查） |
| 数据库 | Cloudflare D1（SQLite 语义，参数化 SQL，无 ORM） |
| 对象存储 | Cloudflare R2（图片二进制） |
| 静态资源 | Workers Static Assets（`public/` 同域下发，`/api/*` 优先进入 Worker） |
| 定时任务 | Cron Triggers（日结 + 清理） |
| 前端 | 原生 HTML / CSS / JavaScript + Phosphor 图标（内联 SVG） |
| 测试 | Vitest 4 + `@cloudflare/vitest-pool-workers`（隔离 D1/R2）；Playwright（E2E 脚手架） |
| 工具链 | Node.js LTS、npm、Wrangler 4 |

---

## 目录结构

```text
gezi/
├── README.md
├── package.json                # 开发 / 检查 / 测试 / 部署脚本
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts            # Workers 测试池配置（隔离 D1/R2 + 迁移注入）
├── wrangler.toml               # Worker、静态资源、D1、R2、Cron 绑定
├── .dev.vars.example           # 本地环境变量示例（不含真实密钥）
├── .gitignore
├── migrations/
│   └── 0001_init.sql           # 全部 13 张表 + 默认配置
├── src/
│   ├── index.ts                # fetch / scheduled 入口、路由、安全响应头
│   ├── util.ts                 # 类型、错误、校验、限流、账户协调租约、配置、审计、账本语句
│   ├── auth.ts                 # 密码（PBKDF2）、会话、注册/登录、首注册管理员
│   ├── posts.ts                # 发布（幂等）、编辑、删除、格子占用、墙面查询
│   ├── points.ts               # 邀请奖励、捐助订单、账本查询
│   ├── billing.ts              # 可重试的日结与中断补算
│   ├── uploads.ts              # 图片校验（含 GIF）、R2 存取、孤儿清理
│   └── admin.ts                # 一次性初始化、配置、批量赠送、捐助确认、日结、清理、审计
├── styles/
│   └── app.css                 # Tailwind 源文件：@theme 品牌令牌 + base 层 + 组件层
├── public/
│   ├── index.html              # 公共像素墙
│   ├── dashboard.html          # 用户后台
│   ├── admin.html              # 管理后台
│   ├── 404.html
│   └── assets/
│       ├── app.css             # Tailwind 构建产物（需提交；由 npm run build:css 生成）
│       ├── wall.css            # 像素墙专属：渐变网格、绝对定位格子、悬停浮层
│       ├── api.js              # 同域 API 封装 + 转义 / 安全链接工具
│       ├── icons.js            # 内联 Phosphor 图标
│       ├── modal.js            # 模态窗组件（Modal.open / confirm / alert）
│       ├── tabs.js             # 后台标签页导航（ARIA tabs + hash 深链 + tab:show 懒加载）
│       ├── wall.js             # 像素墙交互、拖选发布、文字自适应
│       ├── dashboard.js        # 用户后台
│       └── admin.js            # 管理后台
├── docs/
│   └── review.md               # 审查记录、测试证据、迭代历史、已知限制
└── tests/                      # 集成测试（auth / posts / billing / points / uploads / scale）
```

---

## 核心设计

### 坐标与占位
区域用整数 `(x, y, width, height)` 表示，原点左上角，边界 `0 ≤ x`、`0 ≤ y`、`x + width ≤ 100`、`y + height ≤ 100`。`grid_posts` 存内容整体，`grid_cells` 存被占用坐标；`grid_cells` 的 `(x, y)` 主键在数据库层面阻止重复占用，是并发占格的最终防线。

### 积分模型
设面积 `A = width × height`，每格发布价 `P`、每格日价 `D`：

| 项目 | 规则 |
| --- | --- |
| 发布费用 | `A × P`，发布成功时扣除 |
| 每日占用费 | `A × D`，按有效内容逐条结算 |
| 注册奖励 | 每账户一次 |
| 邀请奖励 | 合格首访一次（去重 + 每日上限） |
| 捐助积分 | 管理员确认到账后发放：`floor(金额分 × 兑换率 / 100)` |
| 批量赠送 | 按“批次 + 用户”去重，每人一次 |

积分为非负整数，余额不透支（`users.balance` CHECK 约束）；捐助金额以整数“分”保存，下单锁定兑换率快照。

### 并发与一致性
- **原子事务**：发布、日结、入账等均用 D1 batch（单事务）；任一步失败整体回滚，不出现“扣费未发布 / 发布未扣费”。
- **唯一约束兜底**：占格坐标、发布请求 ID、日结键、账本业务键、捐助交易号、邀请 IP 对，全部用 UNIQUE 保证并发正确性。
- **账户协调租约**：同一账户的余额写操作（发布扣费、日结、入账）先通过条件 `UPDATE` 抢占数据库租约再执行，在数据库层面串行化，不依赖单实例内存锁。
- **日结幂等**：`daily_settlements` 的 `(post_id, billing_date)` 唯一键保证同一内容同一天最多结算一次。

---

## 数据模型

迁移见 [`migrations/0001_init.sql`](migrations/0001_init.sql)，共 13 张表：

| 表 | 用途 | 关键约束 |
| --- | --- | --- |
| `users` | 账户、密码摘要、角色、余额、邀请码、协调状态 | 登录名/邀请码唯一；余额非负 CHECK |
| `sessions` | 会话令牌摘要、到期时间 | 令牌摘要主键；按用户+到期查询 |
| `system_settings` | 费率、奖励、上传上限等运行时配置 | 配置键唯一 |
| `point_ledger` | 积分流水（不可变账本） | `(user_id, business_key)` 唯一 |
| `invite_visits` | 邀请访问 + IP 的 HMAC | `(inviter_id, ip_hash)` 唯一 |
| `uploads` | R2 对象键、归属、类型、尺寸、状态 | 对象键唯一；`available/deleting/deleted` |
| `donation_orders` | 捐助金额分、兑换率快照、积分、状态、渠道/交易号 | `(channel, txn_no)` 唯一 |
| `grid_posts` | 内容归属、矩形、费率快照、结算日期、请求 ID | `(user_id, request_id)` 唯一；矩形边界 CHECK |
| `grid_cells` | 被占用坐标 → 内容 ID | `(x, y)` 主键 |
| `daily_settlements` | 每日结算记录 | `(post_id, billing_date)` 唯一 |
| `bulk_grants` | 批量赠送批次、逐项结果 | `(batch_id, user_id)` 主键 |
| `audit_logs` | 管理操作审计 | 按时间索引；不记录敏感凭据 |
| `rate_limits` | 限流窗口计数 | 桶主键 |

---

## API 一览

所有接口同域 `/api/*`，写接口校验同源（CSRF 防护），全部响应附带安全头。

**公开**
```
GET  /api/health                     健康检查
GET  /api/config                     公开配置（费率、上限等）
GET  /api/wall                       墙面全部有效内容
GET  /api/posts/:id                  内容详情
GET  /api/images/*                   图片（image/<type> + nosniff）
POST /api/invite/visit               邀请访问上报
```

**认证**
```
POST /api/auth/register              注册（首个注册用户自动成为管理员）
POST /api/auth/login                 登录
POST /api/auth/logout                退出
GET  /api/auth/me                    当前用户 + 邀请统计
```

**用户（需登录）**
```
GET    /api/me/posts                 我的内容
GET    /api/me/ledger                我的积分流水（分页）
GET    /api/me/orders                我的捐助订单
POST   /api/me/orders                创建捐助订单
POST   /api/me/orders/:id/cancel     取消待确认订单
POST   /api/uploads                  上传图片
POST   /api/posts                    发布内容（幂等）
PATCH  /api/posts/:id                编辑内容
DELETE /api/posts/:id                删除内容
```

**管理员（需 admin 角色）**
```
POST /api/admin/init                        一次性初始化（备用入口，见下）
GET  /api/admin/settings                    读取配置
PUT  /api/admin/settings                    更新配置
GET  /api/admin/users                       搜索用户
POST /api/admin/users/preview               按条件预览命中用户（只读，不发放）
POST /api/admin/bulk-grants                 批量赠送积分（userIds 或 filter）
GET  /api/admin/bulk-grants                 批次结果查询
POST /api/admin/bulk-grants/:batch/retry    重试批次
GET  /api/admin/donation-orders             捐助订单列表
POST /api/admin/donation-orders/:id/confirm 确认到账
POST /api/admin/settlement/run              手动触发日结
POST /api/admin/cleanup/run                 清理孤儿图片 / 过期会话
GET  /api/admin/audit-logs                  审计日志
```

---

## 本地开发

**前提**：Node.js LTS、npm。版本已在 `package.json` 锁定（wrangler 4、vitest 4、TypeScript 5.8）。

```bash
# 1. 安装依赖
npm install

# 2. 配置本地环境变量：复制示例并填入随机值
cp .dev.vars.example .dev.vars
#   INVITE_HASH_SECRET   邀请 IP HMAC 密钥（独立随机）
#   ADMIN_INIT_TOKEN     一次性初始化令牌（备用入口用）
#   ADMIN_INIT_USERNAME / ADMIN_INIT_PASSWORD

# 3. 初始化本地 D1
npm run db:migrate:local        # = wrangler d1 migrations apply gezi --local

# 4. 启动本地开发服务器（会先构建 Tailwind 产物）
npm run dev                     # = npm run build:css && wrangler dev
```

启动后访问 `http://127.0.0.1:8787`（或 wrangler 指定端口）。本地使用 Wrangler 模拟的 D1 / R2 数据。

> ⚠️ **不要在 `wrangler dev` 运行时执行 `wrangler d1 execute --local`**——两者使用不同持久化实例，会导致开发服务器绑定到空库、接口报错。需要手工改本地数据前先停掉 dev server。

其他脚本：
```bash
npm run build:css  # Tailwind 构建：styles/app.css → public/assets/app.css（压缩）
npm run watch:css  # 改样式时的监听模式，配合另一个终端的 wrangler dev
npm run check      # TypeScript 类型检查（tsc --noEmit）
npm test           # 运行全部集成测试（vitest run）
npm run test:watch # 监听模式
```

### 样式构建

前端样式用 Tailwind CSS v4。源文件是 [`styles/app.css`](styles/app.css)，其中 `@theme` 定义品牌令牌（`--color-panel`、`--color-accent` 等），Tailwind 同时据此生成 utility 并输出到 `:root`，因此 `public/assets/wall.css` 可以直接 `var(--color-*)` 复用同一套值。

> **产物必须提交。** `public/assets/app.css` 是构建输出，但 Workers Static Assets 直接分发 `public/`，部署链路上没有构建钩子。`npm run dev` 与 `npm run deploy` 都已前置 `build:css`；如果手工改了 `styles/app.css` 或新增了 utility class，记得重新构建并提交产物。

> **CSP 约束。** 站点响应头为 `script-src 'self'; style-src 'self'`（见 `src/index.ts`），不允许 CDN 与内联样式。Tailwind 产物是同源静态文件，满足该策略；但这也意味着**不能**改用 Tailwind Play CDN 或任何运行时注入 `<style>` 的方案。

---

## 部署到 Cloudflare

具备账户权限后，创建资源并把 ID 填入 `wrangler.toml`：

```bash
npx wrangler d1 create gezi                 # 把返回的 database_id 填入 wrangler.toml
npx wrangler r2 bucket create gezi          # bucket_name 对应 [[r2_buckets]]

# 注入生产密钥（不写入代码或普通配置）
npx wrangler secret put INVITE_HASH_SECRET
npx wrangler secret put ADMIN_INIT_TOKEN
npx wrangler secret put ADMIN_INIT_USERNAME
npx wrangler secret put ADMIN_INIT_PASSWORD

# 迁移 + 部署
npx wrangler d1 migrations apply gezi --remote     # = npm run db:migrate:remote
npm run deploy                                     # = wrangler deploy
```

部署后检查：资源绑定、静态页面、`/api/*` 鉴权、Cookie 属性、图片访问、Cron 配置。

---

## 管理员账号

**规则（当前版本）：首个成功注册的用户自动成为管理员。** 判定与建号在同一事务内完成（仅当系统中还没有任何管理员时提升），并发注册下只有先提交者成为管理员；此后注册的用户均为普通角色，注册请求携带 `role` 字段无效。

三处明确身份提示：
1. 注册成功时提示“你是本站首位注册用户，已自动成为管理员”；
2. 后台顶栏显示绿色“管理员”徽章；
3. 首页导航出现“管理后台”入口。

**备用入口**：`POST /api/admin/init`（携带 `ADMIN_INIT_TOKEN`）——用于空库部署时受控建立首个管理员。它与“首注册自动提升”互斥：任一方式产生首个管理员后，另一路径不再生效。

**为已有站点追加/调整管理员**：目前需直接改库（暂无升降级界面）：
```bash
npx wrangler d1 execute gezi --remote \
  --command "UPDATE users SET role='admin' WHERE username='要提升的用户名'"
```

> 🔒 **公开部署的抢注风险**：首注册即管理员，公网部署后应第一时间自己注册占位，或改用备用初始化入口。

---

## 系统配置

管理员可在后台调整（仅影响之后的操作，不回溯既有快照）。默认值（见迁移）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `publish_price_p` | 2 | 每格一次性发布价 |
| `daily_price_d` | 1 | 每格每日占用价 |
| `register_reward` | 200 | 注册奖励 |
| `invite_reward` | 20 | 邀请奖励（每次合格首访） |
| `invite_daily_cap` | 5 | 每位邀请人每日奖励上限 |
| `exchange_rate` | 100 | 兑换率（每元积分数） |
| `donation_min_fen` | 100 | 捐助最低金额（分） |
| `upload_max_bytes` | 2097152 | 单图最大字节（2 MiB） |
| `upload_max_width` | 1024 | 图片最大宽 |
| `upload_max_height` | 1024 | 图片最大高 |
| `upload_max_pixels` | 1048576 | 图片总像素上限 |
| `session_ttl_hours` | 168 | 会话有效期（7 天） |

> 动画 GIF 体积普遍偏大，若默认 2 MiB 不够，可将 `upload_max_bytes` 调高（上限 20 MiB）。

---

## 批量赠送（按条件筛选）

后台「批量赠送」支持按条件圈定发放对象，不必手工收集用户 ID。可用条件：

| 条件 | 字段 | 说明 |
| --- | --- | --- |
| 角色 | `role` | `user` / `admin`，留空为全部 |
| 余额区间 | `balanceMin` / `balanceMax` | 含边界 |
| 注册日期区间 | `createdFrom` / `createdTo` | `YYYY-MM-DD`，按 UTC 自然日，含结束当日 |
| 用户名关键词 | `q` | 不区分大小写的子串匹配 |

安全约束（由后端强制，不依赖前端）：

* **条件全空会被拒绝**——空条件等价于“全部用户”，不设防就是一次误操作全员发分；
* **单批上限 500 人**，命中超过上限直接报错，**不做静默截断**，避免“以为发了 800 人实际只发了 500 人”；
* 命中为空同样报错，不会产生空批次；
* **条件在发放时于服务端重新解析**，而不是沿用前端的预览结果，因此发出的人与当时条件完全一致；
* 筛选条件连同人数、金额、原因一并写入审计日志，事后可还原“这批分是按什么条件发的”；
* 发放对象的每个用户仍由 `(batch_id, user_id)` 主键去重，失败项可安全重试。

预览接口 `POST /api/admin/users/preview` 是只读的，返回 `count`、`exceedsLimit` 与最多 20 条样本，供发放前核对人数。

`POST /api/admin/bulk-grants` 同时接受 `userIds`（显式 ID 列表，1-500 个）与 `filter`（筛选条件），两者互斥、必居其一。UI 只用 `filter`；`userIds` 保留以兼容既有调用。

---

## 测试

```bash
npm test        # 43 个集成测试，覆盖：
```
- **账户与会话**：重复注册、错误密码、登出失效、安全响应头、会话数量上限；
- **管理员**：首注册自动成为管理员、后续为普通用户、伪造角色无效、已有管理员时不再提升；
- **越权与 CSRF**：改删他人内容、普通用户调管理接口、跨站写请求；
- **格子边界**：负数/越界/零尺寸/小数/非法链接、全墙 10,000 格原子发布；
- **并发占格**：重叠区域仅一个成功，失败方无残留；
- **发布幂等**：同请求 ID 重放返回原结果、改内容拒绝；
- **编辑与释放**：不改计费快照、删除释放坐标、不退款；
- **日结**：按面积计费、幂等、余额不足过期、跨多日补算顺序、不提前扣未来日期；
- **邀请**：并发首访只奖励一次、自邀/无效码不奖励、每日上限；
- **捐助与批量**：下单不加分、确认幂等、交易号跨订单去重、批次去重；
- **图片**：GIF 识别与动画完整字节流往返、伪造 MIME/SVG 拒绝、超限拒绝、引用他人图片拒绝、孤儿清理；
- **规模**：1,000 条单格内容、账本对账。

测试使用 `@cloudflare/vitest-pool-workers` 在隔离的内存 D1/R2 上运行，每用例前重放迁移。

---

## 安全说明

- **密码**：PBKDF2-SHA256 + 独立随机盐；会话用高熵随机令牌，数据库仅存 SHA-256 摘要。
- **Cookie**：`HttpOnly` + `SameSite=Lax`，生产 `Secure`；退出即删会话，登录清理过期会话并限制每用户会话数。
- **CSRF**：写接口校验 `Origin` / `Sec-Fetch-Site` 同源。
- **响应头**：全部 API 附带 `Content-Security-Policy`（脚本/样式/请求限定同源、`object-src none`、`frame-ancestors none`）、`X-Frame-Options: DENY`、`Referrer-Policy`、`X-Content-Type-Options: nosniff`。
- **限流**：登录、注册、发布、上传、邀请、下单均有基于数据库窗口的频率限制。
- **注入防护**：SQL 全参数绑定；用户文字不渲染为 HTML（前端统一转义）；外链仅 `http/https`、新窗口 `noopener noreferrer`。
- **图片**：按文件头识别类型，拒绝 SVG/HTML 等主动内容；图片响应 `nosniff`。
- **IP 隐私**：邀请去重只存 IP 的 HMAC，不存原始 IP；生产只信任 Cloudflare 提供的客户端 IP。

---

## 已知限制与后续计划

- **无修改密码功能**：用户忘记密码需管理员介入。计划：`POST /api/me/password`（验旧密码 + 撤销旧会话）。
- **`/api/wall` 全量返回**：约 156 B/条，满墙 10,000 条约 1.5 MB；千条内无感知。计划：视口裁剪 / ETag。
- **无用户上传总量配额**：仅频率限制。计划：每用户 available 图片数 / 总字节上限。
- **触摸端无悬停等价交互**：悬停浮层为桌面交互；计划：移动端长按展开。
- **无管理员升降级界面**：当前靠直接改库。计划：后台用户列表一键升降级。
- **满墙渲染**：`fitAllItems` 同步循环，万级内容块文字测量可能阻塞主线程；计划：分帧渲染。

后续扩展：微信/支付宝/Stripe 自动到账（回调验签 + 订单幂等）、图片缩略图、内容举报与审核、邀请风控增强、只读缓存与异步任务。

---

## 许可

内部项目。第三方图标来自 [Phosphor Icons](https://phosphoricons.com)（MIT）。
