/**
 * コマンド共通コンテキスト — Effect Service パターン
 *
 * 背景: pull/push/diff で繰り返される「設定読み込み → テンプレート解決 → クリーンアップ」を
 * Effect の Service として DRY 化する。各コマンドは loadCommandContext を yield* するだけで
 * 設定・lock・テンプレートディレクトリが手に入る。
 *
 * isLocalSource/isGitHubSource の分岐もここで吸収し、
 * resolveBaseRef で透過的にベースリビジョンを解決する。
 */
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { resolve } from "pathe";
import type { ZikuConfig, LockState, TemplateSource } from "../modules/schemas";
import { isLocalSource, isGitHubSource } from "../modules/schemas";
import { FileNotFoundError, ParseError, TemplateError, ZikuError } from "../errors";
import { loadZikuConfig, zikuConfigExists } from "../utils/ziku-config";
import { loadLock } from "../utils/lock";
import { downloadTemplateToTemp, buildTemplateSource } from "../utils/template";
import { resolveLatestCommitSha } from "../utils/github";

// ─── Service 定義 ───

export interface CommandContextShape {
  /** ziku.jsonc のパターン定義 */
  readonly config: ZikuConfig;
  /** lock.json の同期状態（source 含む） */
  readonly lock: LockState;
  /** テンプレートの取得元（lock.source のエイリアス） */
  readonly source: TemplateSource;
  /** 解決済みテンプレ���トディレクトリのパス */
  readonly templateDir: string;
  /** テンプレートの一時ディレクトリを削除する関数 */
  readonly cleanup: () => void;
  /**
   * テンプレートの最新コミット SHA を解決する。
   *
   * GitHub ソースの場合は API で最新 SHA を取得。
   * ローカルソースの場合は undefined を返す。
   * isGitHubSource/isLocalSource の分岐を吸収し、呼び出し元は
   * ソース種別を意識せずに使える。
   */
  readonly resolveBaseRef: Effect.Effect<Option.Option<string>>;
}

/**
 * pull/push/diff 共通のコマンドコンテキスト Service。
 */
export class CommandContext extends Context.Tag("CommandContext")<
  CommandContext,
  CommandContextShape
>() {}

// ─── Effect ヘルパー ───

/**
 * コマンドのエントリポイントで Effect を実行する。
 *
 * 背景: Effect.runPromise は失敗を FiberFailure でラップするため、
 * 既存の ZikuError catch パターン（index.ts のトップレベルハンドラ）と相性が悪い。
 * この関数は Exit から ZikuError を取り出して re-throw することで、
 * 既存のエラーハンドリングフローを維持する。
 *
 * 使い方:
 *   await runCommandEffect(
 *     loadCommandContext(targetDir).pipe(Effect.mapError(toZikuError)),
 *   );
 */
export async function runCommandEffect<A>(effect: Effect.Effect<A, ZikuError>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  throw Option.isSome(failure) ? failure.value : Cause.squash(exit.cause);
}

// ─── Layer 構築 ───

/**
 * targetDir からコマンドコンテキストを構築する Effect。
 *
 * 1. .ziku/ziku.jsonc を読み込み（パターン取得）
 * 2. .ziku/lock.json を読み込み（source + 同期状態）
 * 3. source からテンプレートディレクトリを解決
 * 4. resolveBaseRef を source 種別に応じて構築
 */
export function loadCommandContext(
  targetDir: string,
): Effect.Effect<CommandContextShape, FileNotFoundError | ParseError | TemplateError> {
  return Effect.gen(function* () {
    if (!zikuConfigExists(targetDir)) {
      return yield* new FileNotFoundError({ path: ".ziku/ziku.jsonc" });
    }
    const { config } = yield* Effect.tryPromise({
      try: () => loadZikuConfig(targetDir),
      catch: (e) => new ParseError({ path: ".ziku/ziku.jsonc", cause: e }),
    });

    const lock = yield* Effect.tryPromise({
      try: () => loadLock(targetDir),
      catch: () => new FileNotFoundError({ path: ".ziku/lock.json" }),
    });

    const source = lock.source;
    const { templateDir, cleanup } = yield* resolveTemplateDir(source, targetDir);

    // resolveBaseRef: ソース種別の分岐を吸収
    // resolveLatestCommitSha は Promise<string | undefined> を返すため、
    // Option.fromNullable で undefined → None に正規化してから返す
    const resolveBaseRef = isGitHubSource(source)
      ? Effect.tryPromise(() => resolveLatestCommitSha(source.owner, source.repo)).pipe(
          Effect.map(Option.fromNullable),
          Effect.orElseSucceed(() => Option.none<string>()),
        )
      : Effect.succeed(Option.none<string>());

    return { config, lock, source, templateDir, cleanup, resolveBaseRef };
  });
}

/**
 * TemplateSource からテンプレートディレクトリを解決する Effect。
 */
function resolveTemplateDir(
  source: TemplateSource,
  targetDir: string,
): Effect.Effect<{ templateDir: string; cleanup: () => void }, TemplateError> {
  if (isLocalSource(source)) {
    return Effect.succeed({
      templateDir: resolve(source.path),
      cleanup: () => {},
    });
  }

  return Effect.tryPromise({
    try: () => downloadTemplateToTemp(targetDir, buildTemplateSource(source)),
    catch: (e) =>
      new TemplateError({
        message: `Failed to download template from ${source.owner}/${source.repo}`,
        cause: e,
      }),
  });
}

/**
 * CommandContext の Layer を構築する。
 */
export function makeCommandContextLayer(
  targetDir: string,
): Layer.Layer<CommandContext, FileNotFoundError | ParseError | TemplateError> {
  return Layer.effect(CommandContext, loadCommandContext(targetDir));
}

/**
 * loadCommandContext のエラーを ZikuError に変換するヘルパー。
 *
 * 各コマンドで繰り返される mapError パターンを DRY 化。
 */
export function toZikuError(err: FileNotFoundError | ParseError | TemplateError): ZikuError {
  if (err._tag === "FileNotFoundError") {
    return new ZikuError(`${err.path} not found.`, "Run 'ziku init' first.");
  }
  if (err._tag === "ParseError") {
    return new ZikuError("Failed to parse configuration", String(err.cause));
  }
  return new ZikuError("Failed to load template", err.message);
}
