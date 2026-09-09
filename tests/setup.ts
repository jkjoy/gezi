import { afterEach, beforeAll } from "vitest";
import { applyD1Migrations, env, reset } from "cloudflare:test";

beforeAll(async () => {
  // 每个测试文件在自己的存储层中应用迁移，保证空库可重复初始化
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  // 官方推荐：清空所有绑定存储，保证测试间互不影响。
  // 注意 reset 会同时清掉迁移表 —— 因此在每个测试开始前重新应用迁移。
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
