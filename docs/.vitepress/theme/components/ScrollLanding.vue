<!--
  Apple風スクロール同期ランディングページ。

  スクロール量 = .cast の再生位置 という直接マッピングで、
  ターミナルデモの再生をスクロールで完全にコントロールする。
  各セクションは十分な高さ(300vh等)を持ち、スクロール進捗率を
  asciinema-player の seek(time) に変換してフレーム単位で制御。

  左にターミナル、右に同期する解説ステップを表示する。

  不要条件: ランディングページのデザインを完全に変更する場合。
-->
<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from "vue";
import * as AsciinemaPlayerLib from "asciinema-player";
import "asciinema-player/dist/bundle/asciinema-player.css";

interface Step {
  title: string;
  description: string;
  /** このステップが表示される進捗(0-1) */
  at: number;
}

interface Section {
  id: string;
  label: string;
  castSrc: string;
  cols: number;
  rows: number;
  /** .cast ファイルの実際の録画時間（秒）。タイマーDOMからの取得は不正確なため直接指定 */
  castDuration: number;
  /** スクロールで使える高さ — 長い cast ほど多くする */
  scrollHeight: string;
  steps: Step[];
}

const sections: Section[] = [
  {
    id: "init",
    label: "init",
    castSrc: "/ziku/demos/01-init.cast",
    cols: 100,
    rows: 42,
    castDuration: 21.9,
    scrollHeight: "400vh",
    steps: [
      {
        title: "Run a single command",
        description:
          "npx ziku init --from your-org/templates. That's it. ziku detects the template, connects to the repo, and starts pulling files.",
        at: 0,
      },
      {
        title: "Choose what to sync",
        description:
          "Interactively select which directories to track — .claude, .github, .devcontainer, root configs. Pick only what you need.",
        at: 0.25,
      },
      {
        title: "Handle existing files",
        description:
          "Already have those files? Choose to overwrite, skip, or decide file-by-file. Your existing work is never silently destroyed.",
        at: 0.5,
      },
      {
        title: "Template applied",
        description:
          "Files are copied, .ziku/ziku.jsonc tracks your patterns, and .ziku/lock.json records the sync state. You're ready to go.",
        at: 0.75,
      },
    ],
  },
  {
    id: "push",
    label: "push",
    castSrc: "/ziku/demos/02-push.cast",
    cols: 100,
    rows: 42,
    castDuration: 12.2,
    scrollHeight: "350vh",
    steps: [
      {
        title: "Detect your improvements",
        description:
          "ziku analyzes what changed locally compared to the template — new files, modified configs, improved workflows.",
        at: 0,
      },
      {
        title: "Review the diff",
        description:
          "See exactly what will be pushed back. File-level diffs show additions, modifications, and deletions with full context.",
        at: 0.35,
      },
      {
        title: "Create a Pull Request",
        description:
          "Select what to include and ziku opens a PR on the template repo. Your improvements flow back for everyone to benefit.",
        at: 0.7,
      },
    ],
  },
  {
    id: "pull",
    label: "pull",
    castSrc: "/ziku/demos/03-pull.cast",
    cols: 100,
    rows: 42,
    castDuration: 0.3,
    scrollHeight: "250vh",
    steps: [
      {
        title: "Pull latest template",
        description:
          "When the template gets updated — new CI workflow, better linter config — pull the changes into your project.",
        at: 0,
      },
      {
        title: "3-way merge magic",
        description:
          "JSON, TOML, and YAML files are merged structure-aware. Your local customizations stay intact while template improvements flow in.",
        at: 0.5,
      },
    ],
  },
  {
    id: "diff",
    label: "diff",
    castSrc: "/ziku/demos/04-diff.cast",
    cols: 100,
    rows: 42,
    castDuration: 0.3,
    scrollHeight: "250vh",
    steps: [
      {
        title: "Compare local vs template",
        description:
          "See what drifted since the last sync. Know exactly which files changed, what improved, and what needs attention.",
        at: 0,
      },
      {
        title: "Stay in control",
        description:
          "Never wonder if your project is in sync. The diff shows you the full picture — then you decide what to do about it.",
        at: 0.5,
      },
    ],
  },
];

/** セクションごとのランタイム状態 */
interface SectionState {
  progress: number;
  active: boolean;
  player: ReturnType<typeof AsciinemaPlayerLib.create> | null;
  duration: number;
  containerEl: HTMLDivElement | null;
}

const sectionStates = reactive<Record<string, SectionState>>(
  Object.fromEntries(
    sections.map((s) => [
      s.id,
      { progress: 0, active: false, player: null, duration: 0, containerEl: null },
    ]),
  ),
);

const heroVisible = ref(true);
const ctaVisible = ref(false);
let rafId = 0;
let observers: IntersectionObserver[] = [];

/** セクション要素の ref を収集 */
function setTerminalRef(id: string, el: HTMLDivElement | null) {
  if (el) sectionStates[id].containerEl = el;
}

/**
 * プレイヤーを作成し、ターミナルがレンダリングされるまで待ってから
 * pause + seek でスクロール制御モードに入る。
 *
 * duration は .cast ファイルの実測値を section.castDuration で直接指定する。
 * asciinema-player の getDuration() は Promise を返し、タイミングが不安定なため使わない。
 */
function ensurePlayer(section: Section) {
  const state = sectionStates[section.id];
  if (state.player || !state.containerEl) return;

  // castDuration をそのまま使用
  state.duration = section.castDuration;

  state.player = AsciinemaPlayerLib.create(section.castSrc, state.containerEl, {
    cols: section.cols,
    rows: section.rows,
    speed: 1,
    theme: "asciinema",
    fit: "width",
    idleTimeLimit: 2,
    loop: false,
    autoPlay: true,
  });

  // .ap-term 出現を待ち、pause → 現在のスクロール位置に seek
  const startTime = Date.now();
  function waitForReady() {
    if (!state.player || !state.containerEl) return;
    if (Date.now() - startTime > 5000) return;

    const terminal = state.containerEl.querySelector(".ap-term");
    if (!terminal) {
      setTimeout(waitForReady, 50);
      return;
    }

    state.player.pause();
    const targetTime = state.progress * state.duration;
    (state.player.seek(targetTime) as unknown as Promise<void>).catch(() => {});
  }
  waitForReady();
}

/**
 * スクロール位置から各セクションの進捗率を計算し、
 * asciinema-player を seek で同期させる。
 *
 * seek は Promise を返すため、前の seek が完了するまで次の seek を発行しない。
 */
let seekingSection: string | null = null;

function updateProgress() {
  for (const section of sections) {
    const el = document.getElementById(`chapter-${section.id}`);
    if (!el) continue;

    const rect = el.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const scrollableDistance = el.offsetHeight - viewportH;
    const scrolled = -rect.top;
    const progress = Math.max(0, Math.min(1, scrolled / scrollableDistance));

    const state = sectionStates[section.id];
    state.progress = progress;

    const isVisible = rect.top < viewportH && rect.bottom > 0;
    const wasActive = state.active;
    state.active = isVisible;

    if (isVisible && !wasActive) {
      ensurePlayer(section);
    }

    // seek — Promise なので前のが完了するまでスキップ
    if (isVisible && state.player && state.duration > 0 && seekingSection === null) {
      seekingSection = section.id;
      const targetTime = progress * state.duration;
      (state.player.seek(targetTime) as unknown as Promise<void>)
        .then(() => { seekingSection = null; })
        .catch(() => { seekingSection = null; });
    }
  }

  rafId = requestAnimationFrame(updateProgress);
}

function setupObservers() {
  // Hero
  const heroEl = document.getElementById("landing-hero");
  if (heroEl) {
    const obs = new IntersectionObserver(
      ([e]) => {
        heroVisible.value = e.isIntersecting;
      },
      { threshold: 0.3 },
    );
    obs.observe(heroEl);
    observers.push(obs);
  }

  // CTA
  const ctaEl = document.getElementById("landing-cta");
  if (ctaEl) {
    const obs = new IntersectionObserver(
      ([e]) => {
        ctaVisible.value = e.isIntersecting;
      },
      { threshold: 0.3 },
    );
    obs.observe(ctaEl);
    observers.push(obs);
  }
}

onMounted(() => {
  document.documentElement.classList.add("landing-dark");
  nextTick(() => {
    setupObservers();
    rafId = requestAnimationFrame(updateProgress);
  });
});

onBeforeUnmount(() => {
  document.documentElement.classList.remove("landing-dark");
  cancelAnimationFrame(rafId);
  observers.forEach((o) => o.disconnect());
  for (const state of Object.values(sectionStates)) {
    state.player?.dispose();
  }
});

/** ステップの表示状態を計算 */
function stepOpacity(sectionId: string, stepIndex: number): number {
  const section = sections.find((s) => s.id === sectionId)!;
  const state = sectionStates[sectionId];
  const step = section.steps[stepIndex];
  const nextStep = section.steps[stepIndex + 1];

  const fadeIn = 0.08; // フェードイン区間
  const start = step.at;
  const end = nextStep ? nextStep.at - 0.02 : 1;

  if (state.progress < start) return 0;
  if (state.progress < start + fadeIn) return (state.progress - start) / fadeIn;
  if (state.progress <= end) return 1;
  if (state.progress < end + fadeIn) return 1 - (state.progress - end) / fadeIn;
  return 0;
}

function stepTransform(sectionId: string, stepIndex: number): string {
  const opacity = stepOpacity(sectionId, stepIndex);
  const y = (1 - opacity) * 20;
  return `translateY(${y}px)`;
}
</script>

<template>
  <div class="scroll-landing">
    <!-- ── Hero ── -->
    <section id="landing-hero" class="hero-section">
      <div class="hero-content" :class="{ visible: heroVisible }">
        <div class="hero-badge">Open Source CLI Tool</div>
        <h1 class="hero-title"><span class="hero-title-main">ziku</span></h1>
        <p class="hero-tagline">
          Templates go stale. <strong>ziku</strong> keeps them alive.<br />
          Push improvements back, pull updates forward —<br />
          with structure-aware 3-way merge.
        </p>
        <div class="hero-actions">
          <a href="/ziku/guide/getting-started" class="btn-primary">Get Started</a>
          <a href="https://github.com/tktcorporation/ziku" class="btn-secondary" target="_blank">GitHub</a>
        </div>
      </div>
      <div class="scroll-indicator">
        <span>Scroll to explore</span>
        <div class="scroll-arrow" />
      </div>
    </section>

    <!-- ── Feature chapters ── -->
    <section
      v-for="(section, sIdx) in sections"
      :key="section.id"
      :id="`chapter-${section.id}`"
      class="chapter"
      :style="{ height: section.scrollHeight }"
    >
      <div class="chapter-sticky">
        <!-- Section header -->
        <div class="chapter-header">
          <span class="chapter-number">{{ String(sIdx + 1).padStart(2, "0") }}</span>
          <span class="chapter-divider" />
          <span class="chapter-label">{{ section.label }}</span>
        </div>

        <!-- Two-column layout: terminal + steps -->
        <div class="chapter-layout">
          <div class="terminal-col">
            <div class="terminal-window">
              <div class="terminal-chrome">
                <span class="dot red" /><span class="dot yellow" /><span class="dot green" />
              </div>
              <div
                class="terminal-body"
                :ref="(el) => setTerminalRef(section.id, el as HTMLDivElement)"
              />
            </div>
          </div>

          <div class="steps-col">
            <div
              v-for="(step, i) in section.steps"
              :key="i"
              class="step-card"
              :style="{
                opacity: stepOpacity(section.id, i),
                transform: stepTransform(section.id, i),
              }"
            >
              <h3 class="step-title">{{ step.title }}</h3>
              <p class="step-desc">{{ step.description }}</p>
            </div>
          </div>
        </div>

        <!-- Progress bar -->
        <div class="progress-track">
          <div
            class="progress-fill"
            :style="{ width: (sectionStates[section.id].progress * 100) + '%' }"
          />
        </div>
      </div>
    </section>

    <!-- ── CTA ── -->
    <section id="landing-cta" class="cta-section">
      <div class="cta-content" :class="{ visible: ctaVisible }">
        <h2 class="cta-title">Your templates deserve to evolve.</h2>
        <p class="cta-description">
          Stop copying configs manually. Let every project feed improvements back to your template.
        </p>
        <div class="cta-code"><code>npx ziku</code></div>
        <div class="cta-actions">
          <a href="/ziku/guide/getting-started" class="btn-primary btn-large">Get Started</a>
          <a href="/ziku/guide/demos" class="btn-secondary btn-large">Watch Demos</a>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.scroll-landing {
  --bg: #0a0a0a;
  --text: #fafafa;
  --muted: #888;
  --accent: #3b82f6;
  --accent-hover: #60a5fa;
  --card-bg: #141414;
  --border: #222;

  background: var(--bg);
  color: var(--text);
}

/* ── Hero ───────────────────────────────────── */

.hero-section {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 2rem;
}

.hero-content {
  text-align: center;
  max-width: 800px;
  opacity: 0;
  transform: translateY(40px);
  transition: opacity 0.8s ease, transform 0.8s ease;
}
.hero-content.visible { opacity: 1; transform: translateY(0); }

.hero-badge {
  display: inline-block;
  padding: 0.35rem 1rem;
  border: 1px solid var(--border);
  border-radius: 100px;
  font-size: 0.8rem;
  color: var(--muted);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 2rem;
}

.hero-title { margin: 0 0 1.5rem; line-height: 1; }
.hero-title-main {
  font-size: clamp(4rem, 12vw, 8rem);
  font-weight: 800;
  letter-spacing: -0.04em;
  background: linear-gradient(135deg, #fff 0%, #666 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-tagline {
  font-size: clamp(1rem, 2.5vw, 1.35rem);
  color: var(--muted);
  line-height: 1.7;
  margin: 0 0 2.5rem;
}

.hero-actions { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }

.scroll-indicator {
  position: absolute;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  color: var(--muted);
  font-size: 0.8rem;
  animation: fade-pulse 2s ease-in-out infinite;
}
.scroll-arrow {
  width: 1.5rem; height: 1.5rem;
  border-right: 2px solid var(--muted);
  border-bottom: 2px solid var(--muted);
  transform: rotate(45deg);
  animation: bounce-down 2s ease-in-out infinite;
}
@keyframes fade-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
@keyframes bounce-down {
  0%, 100% { transform: rotate(45deg) translate(0, 0); }
  50% { transform: rotate(45deg) translate(4px, 4px); }
}

/* ── Buttons ────────────────────────────────── */

.btn-primary {
  display: inline-block; padding: 0.75rem 2rem;
  background: var(--accent); color: #fff; border-radius: 8px;
  text-decoration: none; font-weight: 600; font-size: 1rem;
  transition: background 0.2s, transform 0.2s;
}
.btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }

.btn-secondary {
  display: inline-block; padding: 0.75rem 2rem;
  background: transparent; color: var(--text);
  border: 1px solid var(--border); border-radius: 8px;
  text-decoration: none; font-weight: 600; font-size: 1rem;
  transition: border-color 0.2s, transform 0.2s;
}
.btn-secondary:hover { border-color: var(--muted); transform: translateY(-1px); }
.btn-large { padding: 1rem 2.5rem; font-size: 1.1rem; }

/* ── Chapter (feature section) ──────────────── */

.chapter {
  position: relative;
}

.chapter-sticky {
  position: sticky;
  top: 64px;
  height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  padding: 1.5rem 2rem 1rem;
  max-width: 1300px;
  margin: 0 auto;
}

.chapter-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
  flex-shrink: 0;
}
.chapter-number {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.chapter-divider {
  width: 2rem; height: 1px; background: var(--border);
}
.chapter-label {
  font-size: 0.85rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 500;
}

/* ── Two-column layout ──────────────────────── */

.chapter-layout {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 2rem;
  flex: 1;
  min-height: 0;
}

.terminal-col {
  min-height: 0;
  display: flex;
  align-items: stretch;
}

.terminal-window {
  width: 100%;
  background: #1a1a2e;
  border-radius: 12px;
  border: 1px solid var(--border);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.05),
    0 20px 60px rgba(0, 0, 0, 0.5);
}

.terminal-chrome {
  display: flex;
  gap: 6px;
  padding: 0.75rem 1rem;
  background: #0d0d1a;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border); }
.dot.red    { background: #ff5f57; }
.dot.yellow { background: #febc2e; }
.dot.green  { background: #28c840; }

.terminal-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Steps column ───────────────────────────── */

.steps-col {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1.5rem;
  padding: 1rem 0;
}

.step-card {
  padding: 1.25rem 1.5rem;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  transition: box-shadow 0.3s ease;
  will-change: opacity, transform;
}
.step-card:hover {
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.3);
}

.step-title {
  font-size: 1.15rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
  letter-spacing: -0.01em;
}
.step-desc {
  font-size: 0.95rem;
  color: var(--muted);
  line-height: 1.6;
  margin: 0;
}

/* ── Progress bar ───────────────────────────── */

.progress-track {
  height: 2px;
  background: var(--border);
  border-radius: 1px;
  margin-top: auto;
  flex-shrink: 0;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 1px;
  transition: width 0.05s linear;
}

/* ── CTA ────────────────────────────────────── */

.cta-section {
  min-height: 80vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
}

.cta-content {
  text-align: center; max-width: 600px;
  opacity: 0; transform: translateY(40px);
  transition: opacity 0.8s ease, transform 0.8s ease;
}
.cta-content.visible { opacity: 1; transform: translateY(0); }

.cta-title {
  font-size: clamp(1.8rem, 4vw, 2.5rem);
  font-weight: 700; margin: 0 0 1rem; letter-spacing: -0.02em;
}
.cta-description {
  font-size: 1.1rem; color: var(--muted); line-height: 1.6; margin: 0 0 2rem;
}
.cta-code {
  display: inline-block; padding: 0.75rem 2rem;
  background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 8px; margin-bottom: 2.5rem;
}
.cta-code code {
  font-size: 1.2rem; color: var(--accent);
  font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
}
.cta-actions { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }

/* ── Responsive ─────────────────────────────── */

@media (max-width: 900px) {
  .chapter-layout {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
  }

  .steps-col {
    gap: 0.75rem;
    padding: 0;
  }

  .step-card {
    padding: 1rem;
  }

  .hero-title-main { font-size: 3.5rem; }
}

/* ── Asciinema overrides ────────────────────── */

.terminal-body :deep(.ap-wrapper),
.terminal-body :deep(.ap-player) {
  border-radius: 0;
  height: 100% !important;
}

/* スクロール制御時はコントロールバーとスタートオーバーレイを非表示 */
.terminal-body :deep(.ap-overlay),
.terminal-body :deep(.ap-start-button),
.terminal-body :deep(.control-bar) {
  display: none !important;
}
</style>

<!-- ランディングページ専用ダークテーマ。他ページに影響しない。 -->
<style>
.landing-dark .VPNav .VPNavBar {
  background: #0a0a0a !important;
  border-bottom-color: #222 !important;
}
.landing-dark .VPNav .VPNavBar .VPNavBarTitle .title {
  color: #fafafa !important;
}
.landing-dark .VPNav .content-body {
  background: #0a0a0a !important;
}
.landing-dark .VPFooter {
  background: #0a0a0a !important;
  border-top-color: #222 !important;
}
.landing-dark .VPFooter .message,
.landing-dark .VPFooter .copyright {
  color: #888 !important;
}
</style>
