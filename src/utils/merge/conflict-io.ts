/**
 * コンフリクト解決の I/O ユーティリティ。
 *
 * pull/push 共通の「ベースダウンロード→ファイル読み込み→3-way マージ」ロジックを
 * SSOT として集約する。以前は各コマンドに同じコードが分散しており、
 * pull 側にだけ existsSync チェックが漏れて ENOENT クラッシュを引き起こした。
 * ファイル I/O の安全なプリミティブと、1ファイル単位のマージを Effect で提供し、
 * post-merge 処理（ディスク書き込み or Map 保存）は各コマンドに委ねる。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { dirname, join } from "pathe";
import { P, match } from "ts-pattern";
import type { TemplateSource } from "../../modules/schemas";
import { downloadTemplateToTemp } from "../template";
import { log } from "../../ui/renderer";
import type { MergeResult } from "./types";
import { asBaseContent, asLocalContent, asTemplateContent } from "./types";
import { threeWayMerge } from "./three-way-merge";

// ─── ファイル I/O プリミティブ ───

/**
 * ファイルを読み込み、存在しない場合は空文字列を返す。
 * delete/modify conflict でローカルにファイルがないケースに対応するため、
 * existsSync + readFile を毎回手書きする代わりにこの関数を使う。
 */
export const readFileOrEmpty = (path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => readFile(path, "utf-8")).pipe(Effect.orElseSucceed(() => ""));

/**
 * ファイルを書き込む。親ディレクトリがなければ自動作成する。
 * ローカルでファイルもディレクトリも削除されていた場合の復元に使う。
 */
export const writeFileEnsureDir = (path: string, content: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      yield* Effect.tryPromise(() => mkdir(dir, { recursive: true }));
    }
    yield* Effect.tryPromise(() => writeFile(path, content, "utf-8"));
  }).pipe(Effect.orDie);

// ─── 1ファイル単位のマージ ───

export interface MergeOneFileInput {
  /** 対象ファイルの相対パス */
  readonly file: string;
  /** ローカルプロジェクトのルートディレクトリ */
  readonly targetDir: string;
  /** テンプレート（最新版）のディレクトリ */
  readonly templateDir: string;
  /** ベーステンプレート（前回 pull 時点）のディレクトリ。なければ空文字列が base になる */
  readonly baseTemplateDir?: string;
}

export interface MergeOneFileOutput extends MergeResult {
  readonly file: string;
}

/**
 * 1ファイルの 3-way マージを実行する。
 *
 * local/template/base の3バージョンを読み込み、threeWayMerge に渡す。
 * - local, base: ファイルがない場合は readFileOrEmpty で空文字列にフォールバック
 *   （delete/modify conflict でローカルが削除されているケースに対応）
 * - template: 必ず存在する前提（classifyFiles が検出済み）。不在時は orDie でクラッシュ。
 *   テンプレートファイルがないのに conflict に分類されることは classifyFiles の不変条件違反。
 */
export const mergeOneFile = (input: MergeOneFileInput): Effect.Effect<MergeOneFileOutput> =>
  Effect.gen(function* () {
    const localContent = yield* readFileOrEmpty(join(input.targetDir, input.file));
    // テンプレート側のファイルは必ず存在するはず（classifyFiles が検出済み）
    const templateContent = yield* Effect.tryPromise(() =>
      readFile(join(input.templateDir, input.file), "utf-8"),
    );
    const baseContent = input.baseTemplateDir
      ? yield* readFileOrEmpty(join(input.baseTemplateDir, input.file))
      : "";

    const result = threeWayMerge({
      base: asBaseContent(baseContent),
      local: asLocalContent(localContent),
      template: asTemplateContent(templateContent),
      filePath: input.file,
    });

    return { ...result, file: input.file };
  }).pipe(Effect.orDie);

// ─── ベーステンプレートのダウンロード ───

interface DownloadBaseResult {
  readonly templateDir: string;
  readonly cleanup: () => void;
}

/**
 * 3-way マージ用のベーステンプレートをダウンロードする。
 *
 * GitHub ソースの場合: baseRef のコミットからテンプレートをダウンロード。
 * ローカルソース / baseRef なし: null を返す（2-way フォールバック）。
 * ダウンロード失敗時もエラーにせず null を返す（2-way マーカーで対処可能なため）。
 */
export const downloadBaseForMerge = (opts: {
  source: TemplateSource;
  baseRef: string | undefined;
  targetDir: string;
}): Effect.Effect<DownloadBaseResult | null> => {
  if (!opts.baseRef) return Effect.succeed(null);
  const baseRef = opts.baseRef;

  return match(opts.source)
    .with({ owner: P.string, repo: P.string }, (ghSource) =>
      Effect.tryPromise(() => {
        log.info(`Downloading base version (${baseRef.slice(0, 7)}...) for merge...`);
        return downloadTemplateToTemp(
          opts.targetDir,
          `gh:${ghSource.owner}/${ghSource.repo}#${baseRef}`,
          "base",
        );
      }).pipe(
        Effect.orElseSucceed(() => {
          log.warn("Could not download base version. Falling back to 2-way conflict markers.");
          return null;
        }),
      ),
    )
    .with({ path: P.string }, () => Effect.succeed(null))
    .exhaustive();
};
