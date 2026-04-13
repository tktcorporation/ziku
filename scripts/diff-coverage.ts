#!/usr/bin/env pnpm tsx
/**
 * PR 差分カバレッジチェッカー。
 *
 * git diff から変更行を取得し、coverage-final.json のステートメントマップと
 * 突き合わせて「変更行のうちテストでカバーされている割合」を計算する。
 * 閾値を下回った場合は exit code 1 で終了する。
 *
 * Usage:
 *   pnpm tsx scripts/diff-coverage.ts [--threshold 80] [--base origin/main]
 *
 * 前提: `vitest run --coverage` で coverage/coverage-final.json が生成済みであること。
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// ─── CLI 引数パース ───

const args = process.argv.slice(2);

function getArgValue(flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const threshold = Number(getArgValue("--threshold", "80"));
const baseBranch = getArgValue("--base", "origin/main");
const coveragePath = resolve("coverage/coverage-final.json");

// ─── git diff から変更行を抽出 ───

interface ChangedLine {
  file: string;
  line: number;
}

/**
 * git diff --unified=0 の出力から、追加された行の位置を抽出する。
 * 削除行はカバレッジの対象外なので無視する。
 */
function getChangedLines(): ChangedLine[] {
  let diffOutput: string;
  try {
    diffOutput = execFileSync(
      "git",
      ["diff", "--unified=0", "--diff-filter=AMR", `${baseBranch}...HEAD`, "--", "src/**/*.ts"],
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (error: unknown) {
    // baseBranch が存在しない場合（初回PRなど）は空扱い、それ以外は再スロー
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("unknown revision") || message.includes("bad revision")) {
      console.warn(`⚠ Could not diff against ${baseBranch}, skipping diff coverage check`);
      return [];
    }
    throw error;
  }

  const changedLines: ChangedLine[] = [];
  let currentFile = "";

  for (const line of diffOutput.split("\n")) {
    // +++ b/src/utils/merge/classify.ts
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }

    // @@ -old,count +new,count @@ ...
    // 追加行のみ抽出: +new,count の部分
    const hunkMatch = line.match(/^@@ .+ \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const startLine = Number(hunkMatch[1]);
      const lineCount = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      // lineCount === 0 は削除のみの hunk
      for (let i = 0; i < lineCount; i++) {
        changedLines.push({ file: currentFile, line: startLine + i });
      }
    }
  }

  // テストファイルを除外
  return changedLines.filter(
    (cl) => !cl.file.includes("__tests__") && !cl.file.endsWith(".test.ts"),
  );
}

// ─── カバレッジデータの読み込み ───

interface StatementLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface FileCoverage {
  path: string;
  statementMap: Record<string, StatementLocation>;
  s: Record<string, number>;
}

type CoverageData = Record<string, FileCoverage>;

function loadCoverage(): CoverageData {
  try {
    const raw = readFileSync(coveragePath, "utf-8");
    return JSON.parse(raw) as CoverageData;
  } catch {
    console.error(`❌ Coverage file not found: ${coveragePath}`);
    console.error("   Run `pnpm run test:coverage` first.");
    process.exit(1);
  }
}

// ─── 差分カバレッジ計算 ───

interface DiffCoverageResult {
  coveredLines: number;
  uncoveredLines: number;
  totalRelevantLines: number;
  percentage: number;
  uncoveredDetails: Array<{ file: string; lines: number[] }>;
}

function calculateDiffCoverage(
  changedLines: ChangedLine[],
  coverage: CoverageData,
): DiffCoverageResult {
  const projectRoot = resolve(".");
  let coveredLines = 0;
  let uncoveredLines = 0;
  const uncoveredByFile = new Map<string, number[]>();

  for (const { file, line } of changedLines) {
    // coverage-final.json のキーは絶対パス
    const absPath = resolve(projectRoot, file);
    const fileCov = coverage[absPath];

    if (!fileCov) {
      // カバレッジデータにないファイル（新規ファイルなど）は未カバー扱い
      uncoveredLines++;
      const existing = uncoveredByFile.get(file) ?? [];
      existing.push(line);
      uncoveredByFile.set(file, existing);
      continue;
    }

    // この行をカバーするステートメントがあるか探す
    let lineIsCovered = false;
    for (const [stmtId, loc] of Object.entries(fileCov.statementMap)) {
      // ステートメントの範囲内 かつ 実行回数 > 0 ならカバー済み
      if (line >= loc.start.line && line <= loc.end.line && fileCov.s[stmtId] > 0) {
        lineIsCovered = true;
        break;
      }
    }

    if (lineIsCovered) {
      coveredLines++;
    } else {
      uncoveredLines++;
      const existing = uncoveredByFile.get(file) ?? [];
      existing.push(line);
      uncoveredByFile.set(file, existing);
    }
  }

  const totalRelevantLines = coveredLines + uncoveredLines;
  const percentage = totalRelevantLines > 0 ? (coveredLines / totalRelevantLines) * 100 : 100;

  const uncoveredDetails = [...uncoveredByFile.entries()]
    .map(([file, lines]) => ({ file, lines }))
    .sort((a, b) => b.lines.length - a.lines.length);

  return { coveredLines, uncoveredLines, totalRelevantLines, percentage, uncoveredDetails };
}

// ─── 出力 ───

function printResult(result: DiffCoverageResult): void {
  console.log("\n📊 Diff Coverage Report");
  console.log("─────────────────────────────────────");
  console.log(`  Changed lines (src): ${result.totalRelevantLines}`);
  console.log(`  Covered:             ${result.coveredLines}`);
  console.log(`  Uncovered:           ${result.uncoveredLines}`);
  console.log(`  Coverage:            ${result.percentage.toFixed(1)}%`);
  console.log(`  Threshold:           ${threshold}%`);
  console.log("─────────────────────────────────────");

  if (result.uncoveredDetails.length > 0) {
    console.log("\n  Uncovered lines:");
    for (const { file, lines } of result.uncoveredDetails.slice(0, 10)) {
      const lineRanges = compactLineRanges(lines);
      console.log(`    ${file}: ${lineRanges}`);
    }
    if (result.uncoveredDetails.length > 10) {
      console.log(`    ... and ${result.uncoveredDetails.length - 10} more files`);
    }
  }
}

/** 連続する行番号をレンジ表記にまとめる（例: [1,2,3,5,7,8] → "1-3, 5, 7-8"） */
function compactLineRanges(lines: number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}

// ─── main ───

function main(): void {
  console.log(`🔍 Checking diff coverage against ${baseBranch}...`);

  const changedLines = getChangedLines();

  if (changedLines.length === 0) {
    console.log("✅ No changed source lines to check.");
    process.exit(0);
  }

  const coverage = loadCoverage();
  const result = calculateDiffCoverage(changedLines, coverage);

  printResult(result);

  if (result.percentage < threshold) {
    console.log(
      `\n❌ Diff coverage ${result.percentage.toFixed(1)}% is below threshold ${threshold}%`,
    );
    process.exit(1);
  }

  console.log(`\n✅ Diff coverage ${result.percentage.toFixed(1)}% meets threshold ${threshold}%`);
}

main();
