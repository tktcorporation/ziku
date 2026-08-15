import { mkdir, writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { dirname } from "pathe";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import { zikuFailure } from "../errors";
import type { AggregateReport } from "../modules/schemas";
import { runCommandEffect } from "../services/command-context";
import { aggregateOutroLine, renderAggregateSummary } from "../ui/aggregate-view";
import { intro, log, outro, pc, withSpinner } from "../ui/renderer";
import { aggregateTemplateUsage } from "../utils/aggregate";
import { detectGitHubRepo } from "../utils/git-remote";
import { LOCK_FILE } from "../utils/lock";
import { absPath } from "../utils/paths";
import { ZIKU_CONFIG_FILE } from "../utils/ziku-config";

/**
 * aggregate コマンドのファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const aggregateLifecycle: CommandLifecycle = {
  name: "aggregate",
  description: "Inventory unsynced diffs across repositories using this template (read-only)",
  audience: "Template author",
  ops: [
    {
      file: ZIKU_CONFIG_FILE,
      location: "template",
      op: "read",
      note: "比較基準となる include/exclude パターンを取得",
    },
    {
      file: LOCK_FILE,
      location: "remote",
      op: "read",
      note: "owner 配下の候補リポジトリの lock.json を取得し、対象テンプレートの利用リポジトリか判定",
    },
    {
      file: ZIKU_CONFIG_FILE,
      location: "remote",
      op: "read",
      note: "利用リポジトリ側の追跡パターンを取得し、テンプレート側との和集合を比較範囲にする",
    },
    {
      file: SYNCED_FILES,
      location: "template",
      op: "read",
      note: "比較基準としてテンプレートを指定 commit でダウンロードしハッシュ計算",
    },
    {
      file: SYNCED_FILES,
      location: "remote",
      op: "read",
      note: "利用リポジトリをダウンロードし、テンプレートとハッシュ比較して未同期差分を分類",
    },
  ],
  notes: [
    "`aggregate` は読み取り専用。GitHub 上のどのリポジトリの状態も変更しない。",
    "出力する JSON レポートは棚卸し結果であり、テンプレートへの統合（変更の反映）はこのコマンド自身では行わない。統合は後段のエージェントやオペレーターが別途 `push` 等で行う。",
  ],
};

// ─── 入力バリデーション（純粋関数） ───

type SinceParseResult = { readonly ok: true; readonly value: string } | { readonly ok: false };

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 明示的なタイムゾーンオフセット（`Z` または `+HH:MM` / `-HH:MM`）を持つかどうかを判定する。
 * 日付のみの入力（`YYYY-MM-DD`）はこの正規表現にはマッチしない
 * （呼び出し側で `DATE_ONLY_PATTERN` により別扱いする）。
 */
const HAS_EXPLICIT_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** ISO 8601 の日時形式。秒とミリ秒は省略可、オフセットは `Z` / `±HH:MM` / `±HHMM` */
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** `--since` の期待フォーマット。CLI ガード節が `InvalidArgument` の `expected` に使う。 */
export const SINCE_FORMAT_HINT =
  'an ISO 8601 date ("2026-01-01") or date-time ("2026-01-01T09:30:00"); an explicit offset ("+09:00" / "Z") is honored, without one the value is read as UTC';

/**
 * 年月日が実在する組み合わせかを判定する。
 *
 * `new Date("2026-02-30")` は例外を投げず 3 月 2 日へ繰り上がるため、
 * パース結果だけでは存在しない日付を弾けない。
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * `--since` を UTC の ISO 8601 文字列へ正規化する。
 *
 * 背景: `aggregateTemplateUsage`（src/utils/aggregate.ts の `newestCommittedAt`）は
 * 日時を ISO 8601 文字列の辞書順で比較する。オフセット付き入力（例: "+09:00"）を
 * そのまま渡すと辞書順比較が UTC 基準からずれて壊れるため、コマンド層で UTC へ
 * 正規化してから渡す。
 *
 * - 日付のみの入力（`YYYY-MM-DD`）は UTC の 0 時として扱う。
 * - オフセットを持たない日時入力（例: `2026-01-01T00:00:00`）も UTC として解釈する。
 *   `new Date(...)` にオフセット無しの日時文字列を渡すと実行環境のローカルタイムとして
 *   解釈される仕様があり、同じ `--since` の指定でも実行環境のタイムゾーンによって
 *   結果が変わってしまう。日付のみの入力と同じ扱いに揃えるため、オフセットが
 *   無ければ `Z` を補って UTC として固定する。
 *
 * `new Date()` に判定を委ねず、形式と暦日を先に検証する。`new Date()` は
 * `"2026-02-30"` を 3 月 2 日へ繰り上げ、`"01/02/2026"` のような非 ISO 形式も
 * 処理系依存で受理する。どちらも例外にならないため、絞り込みの境界が黙って
 * ずれてレポートからリポジトリが落ちる。
 */
export function normalizeSince(raw: string): SinceParseResult {
  const normalized = DATE_ONLY_PATTERN.test(raw) ? normalizeDateOnly(raw) : normalizeDateTime(raw);
  return normalized === undefined ? { ok: false } : { ok: true, value: normalized };
}

/** `YYYY-MM-DD` を UTC の 0 時として正規化する。暦上ありえない日付は undefined */
function normalizeDateOnly(raw: string): string | undefined {
  const [year, month, day] = raw.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  if (!isRealCalendarDate(year, month, day)) return undefined;
  return new Date(`${raw}T00:00:00.000Z`).toISOString();
}

/**
 * 正規表現のキャプチャを数値化する。省略されたグループ（`undefined`）は
 * `Number()` が `NaN` にしてしまい、以降の範囲比較がすべて false になるため、
 * `undefined` のまま返して呼び出し側の既定値に委ねる。
 */
function toOptionalNumber(captured: string | undefined): number | undefined {
  return captured === undefined ? undefined : Number(captured);
}

/** ISO 8601 の日時を UTC へ正規化する。形式・暦日・時刻が不正なら undefined */
function normalizeDateTime(raw: string): string | undefined {
  const matched = ISO_DATE_TIME_PATTERN.exec(raw);
  if (!matched) return undefined;

  const [year, month, day] = [matched[1], matched[2], matched[3]].map((c) => toOptionalNumber(c));
  if (year === undefined || month === undefined || day === undefined) return undefined;
  if (!isRealCalendarDate(year, month, day)) return undefined;

  const [hour, minute, second] = [matched[4], matched[5], matched[6]].map((c) =>
    toOptionalNumber(c),
  );
  if (!isRealTimeOfDay(hour, minute, second)) return undefined;

  const parsed = new Date(HAS_EXPLICIT_OFFSET_PATTERN.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** 秒 60 はうるう秒表記として ISO 8601 が許すため上限に含める */
function isRealTimeOfDay(hour = 0, minute = 0, second = 0): boolean {
  return hour <= 23 && minute <= 59 && second <= 60;
}

type ConcurrencyParseResult =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false };

/** `--concurrency` の期待フォーマット。CLI ガード節が `InvalidArgument` の `expected` に使う。 */
export const CONCURRENCY_FORMAT_HINT = "a positive integer, e.g. --concurrency=4";

/**
 * `--concurrency` を正の整数として検証する。
 * 未指定（undefined）は `aggregateTemplateUsage` 側の既定値に委ねる。
 */
export function parseConcurrency(raw: string | undefined): ConcurrencyParseResult {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

export const aggregateCommand = defineCommand({
  meta: {
    name: "aggregate",
    description:
      "Inventory unsynced diffs across all repositories using this template (read-only; does not push or consolidate changes)",
  },
  args: {
    dir: {
      type: "positional",
      description: "Template repository directory",
      default: ".",
    },
    owner: {
      type: "string",
      description: "GitHub owner to search for template usage (default: origin owner)",
    },
    since: {
      type: "string",
      description:
        "Only include repositories with pending-push/conflict changes on or after this date/time (ISO 8601; interpreted as UTC unless an explicit offset is given)",
    },
    json: {
      type: "boolean",
      description: "Print the JSON report to stdout (no decoration; safe to pipe)",
      default: false,
    },
    out: {
      type: "string",
      description: "Write the JSON report to this file path",
    },
    "include-archived": {
      type: "boolean",
      description: "Include archived repositories",
      default: false,
    },
    concurrency: {
      type: "string",
      description: "Number of repositories to process concurrently (default: 4)",
    },
  },
  async run({ args }) {
    const jsonMode = args.json as boolean;

    // --json は後段の機械（エージェント等）が stdout をそのまま JSON.parse する前提の
    // モード。intro/outro/spinner/log はすべて @clack/prompts 経由で stdout に書かれるため、
    // --json 時はこれらを一切呼ばない（装飾を混ぜない）。
    if (!jsonMode) intro("aggregate");

    const targetDir = absPath(args.dir as string);

    const templateRepo = detectGitHubRepo(targetDir);
    if (!templateRepo) {
      throw zikuFailure({
        kind: "InvalidArgument",
        argument: "dir",
        value: targetDir,
        expected:
          "a directory with a GitHub 'origin' remote — run `ziku aggregate` inside the template repository's git checkout, or pass DIR to point at one",
      });
    }

    const owner = (args.owner as string | undefined) ?? templateRepo.owner;

    const sinceRaw = args.since as string | undefined;
    let since: string | undefined;
    if (sinceRaw !== undefined) {
      const parsedSince = normalizeSince(sinceRaw);
      if (!parsedSince.ok) {
        throw zikuFailure({
          kind: "InvalidArgument",
          argument: "--since",
          value: sinceRaw,
          expected: SINCE_FORMAT_HINT,
        });
      }
      since = parsedSince.value;
    }

    const concurrencyRaw = args.concurrency as string | undefined;
    const parsedConcurrency = parseConcurrency(concurrencyRaw);
    if (!parsedConcurrency.ok) {
      throw zikuFailure({
        kind: "InvalidArgument",
        argument: "--concurrency",
        value: concurrencyRaw ?? "",
        expected: CONCURRENCY_FORMAT_HINT,
      });
    }

    const includeArchived = args["include-archived"] as boolean;

    if (!jsonMode) {
      log.info(`Template: ${pc.cyan(`${templateRepo.owner}/${templateRepo.repo}`)}`);
      log.info(`Searching repositories owned by: ${pc.cyan(owner)}`);
    }

    const aggregateEffect = aggregateTemplateUsage({
      template: { owner: templateRepo.owner, repo: templateRepo.repo },
      searchOwner: owner,
      includeArchived,
      concurrency: parsedConcurrency.value,
      since,
    });

    const report: AggregateReport = jsonMode
      ? await runCommandEffect(aggregateEffect)
      : await withSpinner("Scanning repositories for template usage...", () =>
          runCommandEffect(aggregateEffect),
        );

    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    // ファイルへの書き出しは outro より前に済ませる。outro は clack のブロックを閉じるので、
    // 後に log を出すと終了バーの下へはみ出す。書き込みが失敗したときに成功を告げないためでもある。
    const outArg = args.out as string | undefined;
    const outPath = outArg === undefined ? undefined : absPath(outArg);
    if (outPath !== undefined) {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, serialized, "utf-8");
    }

    if (jsonMode) {
      process.stdout.write(serialized);
      return;
    }

    if (outPath !== undefined) log.success(`Report written to ${pc.cyan(outPath)}`);
    log.message(renderAggregateSummary(report));
    outro(aggregateOutroLine(report));
  },
});
