import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // scripts/docs-lifecycle は bun:test 前提の独立サブプロジェクト（bunfig.toml 参照）。
    // vitest では bun:test を解決できないため、ここで対象外にして bun test に任せる。
    exclude: ["**/node_modules/**", "scripts/docs-lifecycle/**"],
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
