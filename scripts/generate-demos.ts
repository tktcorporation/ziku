/**
 * デモの .cast ファイル（asciinema 形式）を生成するスクリプト。
 *
 * demos/*.md の各シナリオファイルを terminal-demo で再生し、
 * docs/public/demos/ に .cast ファイルとして出力する。
 *
 * 用途: ドキュメントサイトや README でのデモ動画埋め込み素材の生成。
 * 不要条件: terminal-demo 以外のデモツールに移行する場合。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEMOS_DIR = resolve(ROOT, "demos");
const OUTPUT_DIR = resolve(ROOT, "docs/public/demos");

if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

const files = readdirSync(DEMOS_DIR)
  .filter((f) => f.endsWith(".md"))
  .toSorted();

if (files.length === 0) {
  console.log("No demo files found in demos/");
  process.exit(0);
}

console.log(`Generating ${files.length} demo recordings...\n`);

for (const file of files) {
  const input = resolve(DEMOS_DIR, file);
  const name = file.replace(/\.md$/, "");
  const output = resolve(OUTPUT_DIR, `${name}.cast`);

  console.log(`  ${file} → demos/${name}.cast`);

  execFileSync("npx", ["terminal-demo", "play", input, "--record", output, "--speed", "3"], {
    stdio: ["pipe", "pipe", "inherit"],
    input: "\n",
    cwd: ROOT,
  });
}

console.log(`\nDone! ${files.length} .cast files written to docs/public/demos/`);
