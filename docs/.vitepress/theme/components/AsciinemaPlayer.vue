<!--
  asciinema-player の Vue ラッパー。

  ブラウザ上でのみ動作する（SSR 非対応）ため、theme/index.ts で
  defineClientComponent() 経由で登録する。

  スクロールで viewport に入ると自動再生し、出ると一時停止する。
  不要条件: asciinema 以外のプレイヤーに移行する場合。
-->
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import * as AsciinemaPlayerLib from "asciinema-player";
// eslint-disable-next-line import/no-unassigned-import -- CSS side-effect import
import "asciinema-player/dist/bundle/asciinema-player.css";

const props = withDefaults(
  defineProps<{
    /** .cast ファイルのパス（public/ 基準） */
    src: string;
    cols?: number;
    rows?: number;
    speed?: number;
    theme?: string;
    fit?: "width" | "height" | "both" | "none";
    idleTimeLimit?: number;
    /** viewport に入ったら自動再生する */
    autoPlayOnScroll?: boolean;
    /** ループ再生 */
    loop?: boolean;
  }>(),
  {
    cols: 80,
    rows: 24,
    speed: 1,
    theme: "asciinema",
    fit: "width",
    idleTimeLimit: 2,
    autoPlayOnScroll: false,
    loop: false,
  },
);

const container = ref<HTMLDivElement>();
let player: { dispose: () => void; play: () => void; pause: () => void } | null = null;
let observer: IntersectionObserver | null = null;

/**
 * モバイル幅では viewport が狭く、fit: "width" で cols=100 を描画すると
 * 1 文字あたり数 px しかなく読めない。VT 側の cols を 60 まで絞ることで
 * 1 文字を大きく描画しつつ、長い行は asciinema-player の VT が自動で
 * 折り返す（.ap-line は absolute 配置のため CSS 側での折り返しは不可）。
 */
const MOBILE_BREAKPOINT = 900;
const MOBILE_MAX_COLS = 60;

function getEffectiveCols(): number {
  if (typeof window === "undefined") return props.cols;
  if (window.innerWidth > MOBILE_BREAKPOINT) return props.cols;
  return Math.min(props.cols, MOBILE_MAX_COLS);
}

function createPlayer() {
  if (!container.value) return;
  player = AsciinemaPlayerLib.create(props.src, container.value, {
    cols: getEffectiveCols(),
    rows: props.rows,
    speed: props.speed,
    theme: props.theme,
    fit: props.fit,
    idleTimeLimit: props.idleTimeLimit,
    loop: props.loop,
    autoPlay: false,
  });

  if (props.autoPlayOnScroll) {
    setupScrollObserver();
  }
}

/** viewport の 30% 以上が見えたら再生、外れたら一時停止 */
function setupScrollObserver() {
  if (!container.value) return;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          player?.play();
        } else {
          player?.pause();
        }
      }
    },
    { threshold: 0.3 },
  );

  observer.observe(container.value);
}

function clearContainer() {
  if (!container.value) return;
  while (container.value.firstChild) {
    container.value.removeChild(container.value.firstChild);
  }
}

function recreatePlayer() {
  observer?.disconnect();
  player?.dispose();
  clearContainer();
  createPlayer();
}

let mobileMql: MediaQueryList | null = null;

onMounted(() => {
  createPlayer();
  // モバイル/デスクトップ閾値を跨いだ際に cols を反映させるため再生成する
  mobileMql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
  mobileMql.addEventListener("change", recreatePlayer);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  mobileMql?.removeEventListener("change", recreatePlayer);
  player?.dispose();
});

watch(() => props.src, recreatePlayer);
</script>

<template>
  <div ref="container" class="asciinema-container" />
</template>

<style scoped>
.asciinema-container {
  margin: 1rem 0;
  border-radius: 8px;
  overflow: hidden;
}
</style>
