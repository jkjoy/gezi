/**
 * 测试环境声明。
 * 新版 @cloudflare/vitest-pool-workers 通过全局 Cloudflare.Env 命名空间
 * 为 "cloudflare:test" 的 env 提供类型；此处补充我们的绑定。
 * TEST_MIGRATIONS 在 vitest.config.ts 中注入，setup.ts 应用到隔离的 D1 存储。
 */
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      UPLOADS: R2Bucket;
      ASSETS?: Fetcher;
      INVITE_HASH_SECRET: string;
      ADMIN_INIT_TOKEN: string;
      ADMIN_INIT_USERNAME: string;
      ADMIN_INIT_PASSWORD: string;
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
  }
}

export {};
