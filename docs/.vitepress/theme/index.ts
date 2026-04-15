/**
 * VitePress カスタムテーマ。
 *
 * デフォルトテーマを拡張し、グローバルコンポーネント（AsciinemaPlayer 等）を登録する。
 * デフォルトテーマ不要時: このファイルごと削除して config.ts のみに戻せる。
 */
import DefaultTheme from "vitepress/theme";
import { defineClientComponent } from "vitepress";

// asciinema-player はブラウザ API 依存のため SSR をスキップする
const AsciinemaPlayer = defineClientComponent(
  () => import("./components/AsciinemaPlayer.vue"),
);

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("AsciinemaPlayer", AsciinemaPlayer);
  },
};
