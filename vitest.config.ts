import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // 测试使用内存存储，避免污染 .wrangler/state 下的本地开发数据
          d1Persist: false,
          r2Persist: false,
          bindings: {
            TEST_MIGRATIONS: migrations,
            INVITE_HASH_SECRET: "test-invite-hash-secret-0123456789abcdef",
            ADMIN_INIT_TOKEN: "test-admin-init-token",
            ADMIN_INIT_USERNAME: "root",
            ADMIN_INIT_PASSWORD: "test-admin-password-123",
          },
        },
      }),
    ],
    test: {
      include: ["tests/**/*.test.ts"],
      setupFiles: ["./tests/setup.ts"],
    },
  };
});
