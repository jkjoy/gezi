# Review 记录 — 2026-09-09 首版实现

## 审查范围

对照 README 完成首版实现的代码审查与行为测试。范围：`src/`（8 个模块）、`migrations/0001_init.sql`、`public/`（3 个页面 + 4 个静态资源）、`wrangler.toml`、测试（6 个文件，39 个用例）。

## 实际执行的命令与结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run check`（tsc --noEmit） | 通过，无错误 |
| 业务与数据库测试 | `npm test`（vitest，@cloudflare/vitest-pool-workers 0.22 + vitest 4.1 + wrangler 4.130） | 6 个文件 39/39 通过（Windows，Node 24.15） |
| 部署打包 | `npx wrangler deploy --dry-run` | 构建成功，80.07 KiB（gzip 18.98 KiB），绑定 D1/R2/Assets 正常 |
| 环境冒烟（远程） | — | **未验证**：无 Cloudflare 账户权限。`wrangler.toml` 中的 `database_id` 为占位符，部署前需替换 |
| 浏览器验收（Playwright） | — | **未验证**：`playwright.config.ts` 与用例尚未编写（见已知限制） |

## 发现并修复的问题（本次开发过程中）

| 级别 | 问题 | 修复 |
| --- | --- | --- |
| 阻断 | `settleOneDay` 只按 `price_d` 扣费，漏乘面积（`width×height`），2×2 内容只扣 1 积分/日而非 4 | `src/billing.ts` 改为 `price_d × width × height`，并有回归测试覆盖 |
| 一般 | 依赖冲突：最新 wrangler 4.130 需要 workers-types v5 与 vitest-pool-workers 0.22/vitest 4 | 锁定 `wrangler ^4.130.0`、`@cloudflare/vitest-pool-workers ^0.22.0`、`vitest ^4.1.0`、`workers-types ^5` |
| 一般 | 新版测试池不再提供 per-test 存储隔离，测试间数据串扰 | `tests/setup.ts` 在 `afterEach` 中调用官方 `reset()` 并重新应用迁移 |
| 一般 | 测试用直接 UPDATE 补余额导致账本对账断言失真 | `grantPoints` 统一走余额+流水双写 |

## 已验证的验收场景（行为测试）

- **注册与会话**：重复注册 409；错误密码 401；登出后 Cookie 失效；注册奖励只发一次。
- **管理员初始化**：错误令牌 403；成功一次后入口关闭（`admin_initialized` 开关在同一事务内置位）；普通注册无法获得管理员角色；管理员账户不发注册奖励。
- **越权与 CSRF**：用户 A 改/删 B 的内容 403；普通用户调管理员接口 403；跨站 Origin 写请求 403（`csrf`）。
- **格子边界**：负数、越界、零尺寸、小数、`javascript:` 链接全部 400。
- **并发占格**：两账户并发发布重叠区域，一胜（200）一败（409），失败方无扣费无残留。
- **余额并发/不足**：余额不足返回业务错误且无扣费、无占格、无流水。
- **发布失败与重试**：同请求 ID 重试返回原结果（`replayed: true`）且不重复扣费；改内容 409。
- **编辑与释放**：编辑不改计费快照与位置；删除释放全部坐标、不退款、可被他人重新占用。
- **计费日界线**：发布当日只扣发布费；`next_billing_date` = 下一 UTC 日。
- **日结重入与补算**：`daily_settlements` 唯一键保证重复运行不重复扣费；按"应结算日期、发布时间、内容 ID"排序补算；不能提前扣未来日期。
- **余额不足排序**：余额只够第一条时，第一条续占、第二条过期并释放格子，无部分扣费。
- **逾期恢复**：逾期过期后充值不能恢复；删除前先补算（不能绕过到期费用）。
- **邀请奖励**：同 IP 重访（含并发）只奖励一次；无效码/自邀不奖励；每日上限生效。
- **捐助与批量发分**：下单不加分；确认按下单快照入账一次；重复确认幂等；同渠道同交易号跨订单 409；已取消订单不能确认；批次重试与重复 ID 不重复赠送。
- **图片与内容安全**：仅 PNG/JPEG/WebP magic bytes 通过；SVG/HTML/空文件拒绝；引用他人图片 400；超大小限制 413；图片响应带 `nosniff`。
- **图片清理**：孤儿对象可清理；被有效内容引用的图片不被误删。
- **账本对账**：注册+邀请+捐助+批量后 `SUM(point_ledger) = users.balance`。
- **极端规模**：一条内容占满全墙（10,000 格单事务原子写入）；1,000 条单格内容（占用、墙面查询 8ms@1000 条、余额一致）。

## 未验证项及原因

1. **远程部署与 Cron 实际触发**：需要 Cloudflare 账户权限与真实资源 ID；部署步骤见 README。
2. **Playwright 浏览器验收**：`@playwright/test` 已在依赖中，`test:e2e` 脚本已就位，但用例未编写——列为下一步。
3. **性能预算实测**（首屏、D1 查询数、日结吞吐的量化指标）：本地 vitest 环境的计时不能代表 Workers 生产环境，需预发布环境实测后记录。
4. **PBKDF2 迭代次数与 Workers CPU 限额的匹配**：当前 100,000 次，本地测试通过；免费计划单请求 CPU 约 10ms，若生产出现 1102 超限需降低并强制重置密码。

## 已知限制

- 速率限制（登录/注册/发布/上传/邀请）基于 D1 表实现，窗口粒度较粗；高流量下可换成 Cloudflare Rate Limiting binding。
- 邀请 IP 去重依赖 `INVITE_HASH_SECRET`，密钥轮换会改变去重结果（README 已声明）。
- 墙面 `/api/wall` 全量返回所有 active 内容，无分页；满墙 10,000 条时响应体较大（测试验证 1,000 条 8ms；10,000 条单格属于极端场景，后续可加分页或视口裁剪）。
- 管理员初始化依赖 `.dev.vars`/secrets 中的 `ADMIN_INIT_TOKEN`；token 泄露即可能被抢先初始化，部署后应尽快完成初始化。

## 剩余风险与后续迭代

- [ ] Playwright e2e（桌面 + 移动视口）
- [ ] 预发布环境冒烟：迁移、绑定、Cron、图片访问
- [ ] 性能预算制定与实测记录
- [ ] 墙面查询分页/视口裁剪（优化级）

## 2026-09-10 UI 交互迭代

依据实际使用反馈完成三项交互调整与两项界面改进。

### 变更

- **墙面交互**（`public/assets/wall.js`、`style.css`）：
  - 内容块文字按区域短边等比例缩放（7–72px），窗口 resize 时防抖重算；
  - 悬停内容块显示浮层（完整文字、位置尺寸、链接，自动避让视口边缘）；
  - 点击带链接的内容块直接 `window.open(url, "_blank", "noopener,noreferrer")`；无链接块不响应；
  - 移除详情面板；`GET /api/posts/:id` 接口保留。
- **后端**（`src/posts.ts`）：`GET /api/wall` 返回 `link` 字段（写入时已限制 http/https，前端打开前经 `API.safeLink` 二次校验）。
- **图标**（新增 `public/assets/icons.js`）：内联 Phosphor Icons 28 枚（Cloudflare kumo 组件库的图标来源，MIT），无 CDN / 构建依赖。注：kumo 本体为 React + Base UI 组件库，与本项目无框架架构不兼容，故采用其图标集而非组件。
- **用户后台**：未登录仅显示居中登录/注册卡（账户 / 我的内容 / 流水 / 捐助区块隐藏）；修复 `[hidden]` 属性被 `display: grid` 覆盖导致区块泄漏的问题（`[hidden] { display: none !important }`）。

### 验证（本地 dev server + 浏览器实测）

| 项 | 证据 |
| --- | --- |
| 文字等比 | 实测字号随区域单调递增：2×2=7.8px、4×3=11.7px、4×4=15.7px、12×5=19.6px、8×6=23.5px |
| 悬停浮层 | 显示全文 / 位置尺寸 / 链接；鼠标跟随并避让视口边缘 |
| 点击直达 | 带链接块触发 `window.open(..., noopener,noreferrer)`；无链接块不动作 |
| 登录门控 | 未登录时 `app-content` 计算样式 `display:none`，仅登录卡可见 |
| UTF-8 | 浏览器发布 `像素墙 🎨 你好世界`（中文+emoji）墙面 / 悬停 / 后台均正确；此前乱码确认为 curl/终端编码所致（服务端无缺陷） |
| 回归 | `tsc --noEmit` 无错误；vitest 39/39 通过（新增 `/api/wall` link 字段断言）；`wrangler deploy --dry-run` 打包成功（80.17 KiB） |

### 已知限制

- 悬停浮层无触摸端等价交互（原移动端详情面板已移除），后续可为触摸端补充长按或点击展开。
- `/api/wall` 仍全量返回，无分页（沿首版已知限制）。
