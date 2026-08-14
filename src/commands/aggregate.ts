import { mkdir, writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { dirname, resolve } from "pathe";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import { ZikuError } from "../errors";
import type { GitHubApiError, TemplateError } from "../errors";
import type { AggregateReport } from "../modules/schemas";
import { runCommandEffect } from "../services/command-context";
import { aggregateOutroLine, renderAggregateSummary } from "../ui/aggregate-view";
import { intro, log, outro, pc, withSpinner } from "../ui/renderer";
import { aggregateTemplateUsage } from "../utils/aggregate";
import { detectGitHubRepo } from "../utils/git-remote";
import { LOCK_FILE } from "../utils/lock";
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

type SinceParseResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 明示的なタイムゾーンオフセット（`Z` または `+HH:MM` / `-HH:MM`）を持つかどうかを判定する。
 * 日付のみの入力（`YYYY-MM-DD`）はこの正規表現にはマッチしない
 * （呼び出し側で `DATE_ONLY_PATTERN` により別扱いする）。
 */
const HAS_EXPLICIT_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

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
 */
export function normalizeSince(raw: string): SinceParseResult {
  const candidate = DATE_ONLY_PATTERN.test(raw)
    ? `${raw}T00:00:00.000Z`
    : HAS_EXPLICIT_OFFSET_PATTERN.test(raw)
      ? raw
      : `${raw}Z`;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      message: `Invalid --since value: "${raw}". Use an ISO 8601 date (e.g. "2026-01-01") or a date-time (an explicit offset such as "2026-01-01T00:00:00+09:00" is honored; without one, it is interpreted as UTC).`,
    };
  }
  return { ok: true, value: parsed.toISOString() };
}

type ConcurrencyParseResult =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * `--concurrency` を正の整数として検証する。
 * 未指定（undefined）は `aggregateTemplateUsage` 側の既定値に委ねる。
 */
export function parseConcurrency(raw: string | undefined): ConcurrencyParseResult {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return {
      ok: false,
      message: `Invalid --concurrency value: "${raw}". Provide a positive integer, e.g. --concurrency=4.`,
    };
  }
  return { ok: true, value };
}

/** aggregateTemplateUsage が返すエラーを、コマンド層の ZikuError に変換する */
function toAggregateZikuError(err: GitHubApiError | TemplateError): ZikuError {
  if (err._tag === "GitHubApiError") {
    return new ZikuError(
      `GitHub API error: ${err.message}`,
      "Check that a GitHub token with access to the owner's repositories is available, and that --owner is correct.",
    );
  }
  return new ZikuError(
    `Failed to prepare the template repository for comparison: ${err.message}`,
    "Check that the template repository and its default branch are reachable.",
  );
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

    const targetDir = resolve(args.dir);

    const templateRepo = detectGitHubRepo(targetDir);
    if (!templateRepo) {
      throw new ZikuError(
        `Could not detect a GitHub repository at ${targetDir}.`,
        "Run `ziku aggregate` inside the template repository's git checkout (it must have a GitHub 'origin' remote), or pass DIR to point at one.",
      );
    }

    const owner = (args.owner as string | undefined) ?? templateRepo.owner;

    const sinceRaw = args.since as string | undefined;
    let since: string | undefined;
    if (sinceRaw !== undefined) {
      const parsedSince = normalizeSince(sinceRaw);
      if (!parsedSince.ok) {
        throw new ZikuError(
          parsedSince.message,
          'Examples: --since="2026-01-01" or --since="2026-01-01T00:00:00+09:00"',
        );
      }
      since = parsedSince.value;
    }

    const parsedConcurrency = parseConcurrency(args.concurrency as string | undefined);
    if (!parsedConcurrency.ok) {
      throw new ZikuError(parsedConcurrency.message, "Example: --concurrency=4");
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
    }).pipe(Effect.mapError(toAggregateZikuError));

    const report: AggregateReport = jsonMode
      ? await runCommandEffect(aggregateEffect)
      : await withSpinner("Scanning repositories for template usage...", () =>
          runCommandEffect(aggregateEffect),
        );

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      log.message(renderAggregateSummary(report));
      outro(aggregateOutroLine(report));
    }

    const outArg = args.out as string | undefined;
    if (outArg !== undefined) {
      const outPath = resolve(outArg);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
      if (!jsonMode) log.success(`Report written to ${pc.cyan(outPath)}`);
    }
  },
});
