import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 実ネットワークへ出る経路を塞ぐ。理由は src/__tests__/no-network.ts を参照。
    setupFiles: ["src/__tests__/no-network.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/__tests__/no-network.ts"],
      reporter: ["text", "json"],
    },
  },
});
