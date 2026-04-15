<!--
  asciinema-player の Vue ラッパー。

  ブラウザ上でのみ動作する（SSR 非対応）ため、theme/index.ts で
  defineClientComponent() 経由で登録する。
  不要条件: asciinema 以外のプレイヤーに移行する場合。
-->
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import * as AsciinemaPlayerLib from "asciinema-player";
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
  }>(),
  {
    cols: 80,
    rows: 24,
    speed: 1,
    theme: "asciinema",
    fit: "width",
    idleTimeLimit: 2,
  },
);

const container = ref<HTMLDivElement>();
let player: { dispose: () => void } | null = null;

function createPlayer() {
  if (!container.value) return;
  player = AsciinemaPlayerLib.create(props.src, container.value, {
    cols: props.cols,
    rows: props.rows,
    speed: props.speed,
    theme: props.theme,
    fit: props.fit,
    idleTimeLimit: props.idleTimeLimit,
    autoPlay: false,
  });
}

function clearContainer() {
  if (!container.value) return;
  while (container.value.firstChild) {
    container.value.removeChild(container.value.firstChild);
  }
}

onMounted(() => {
  createPlayer();
});

onBeforeUnmount(() => {
  player?.dispose();
});

watch(
  () => props.src,
  () => {
    player?.dispose();
    clearContainer();
    createPlayer();
  },
);
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
