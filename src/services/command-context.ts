/**
 * コマンド共通コンテキスト — Effect Service パターン
 *
 * 背景: pull/push/diff で繰り返される「設定読み込み → テンプレート解決 → クリーンアップ」を
 * Effect の Service として DRY 化する。各コマンドは CommandContext を yield* するだけで、
 * 設定・lock・テンプレートディレクトリが手に入る。
 *
 * Effect の R（Requirements）チャネルを使った DI:
 *   - テスト時は CommandContext をモックの Layer で差し替え可能
 *   - 本番では loadCommandContext で実装を注入
 */
import { Context, Effect, Layer } from "effect";
import { resolve } from "pathe";
import type { ZikuConfig, LockState, TemplateSource } from "../modules/schemas";
import { isLocalSource } from "../modules/schemas";
import { FileNotFoundError, ParseError, TemplateError } from "../errors";
import { loadZikuConfig, zikuConfigExists } from "../utils/ziku-config";
import { loadLock } from "../utils/lock";
import { downloadTemplateToTemp, buildTemplateSource } from "../utils/template";

// ─── Service 定義 ───

export interface CommandContextShape {
  /** ziku.jsonc のパターン定義 */
  readonly config: ZikuConfig;
  /** lock.json の同期状態（source 含む） */
  readonly lock: LockState;
  /** テンプレートの取得元（lock.source のエイリアス） */
  readonly source: TemplateSource;
  /** 解決済みテンプレートディレクトリのパス */
  readonly templateDir: string;
  /** テンプレートの一時ディレクトリを削除する関数 */
  readonly cleanup: () => void;
}

/**
 * pull/push/diff 共通のコマンドコンテキスト Service。
 *
 * 各コマンドは `yield* CommandContext` でコンテキストを取得し、
 * `Effect.ensuring` で cleanup を保証する。
 */
export class CommandContext extends Context.Tag("CommandContext")<
  CommandContext,
  CommandContextShape
>() {}

// ─── Layer 構築 ───

/** ziku.jsonc と lock.json が見つからない場合のエラー */
export class NotInitializedError extends Effect.Tag("NotInitializedError")<
  NotInitializedError,
  { readonly message: string }
>() {}

/**
 * targetDir からコマンドコンテキストを構築する Effect。
 *
 * 1. .ziku/ziku.jsonc を読み込み（パターン取得）
 * 2. .ziku/lock.json を読み込み（source + 同期状態）
 * 3. source からテンプレートディレクトリを解決
 */
export function loadCommandContext(
  targetDir: string,
): Effect.Effect<CommandContextShape, FileNotFoundError | ParseError | TemplateError> {
  return Effect.gen(function* () {
    // ziku.jsonc を読み込み
    if (!zikuConfigExists(targetDir)) {
      return yield* new FileNotFoundError({ path: ".ziku/ziku.jsonc" });
    }
    const { config } = yield* Effect.tryPromise({
      try: () => loadZikuConfig(targetDir),
      catch: (e) => new ParseError({ path: ".ziku/ziku.jsonc", cause: e }),
    });

    // lock.json を読み込み
    const lock = yield* Effect.tryPromise({
      try: () => loadLock(targetDir),
      catch: () => new FileNotFoundError({ path: ".ziku/lock.json" }),
    });

    const source = lock.source;

    // テンプレートディレクトリを解決
    const { templateDir, cleanup } = yield* resolveTemplateDir(source, targetDir);

    return { config, lock, source, templateDir, cleanup };
  });
}

/**
 * TemplateSource からテンプレートディレクトリを解決する Effect。
 *
 * ローカルソース → パスをそのまま返す
 * GitHub ソース → ダウンロードして一時ディレクトリを返す
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
 *
 * 使い方:
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const ctx = yield* CommandContext;
 *   // ctx.config, ctx.lock, ctx.templateDir を使う
 * });
 *
 * Effect.runPromise(
 *   program.pipe(Effect.provide(CommandContext.Live(targetDir)))
 * );
 * ```
 */
export function makeCommandContextLayer(
  targetDir: string,
): Layer.Layer<CommandContext, FileNotFoundError | ParseError | TemplateError> {
  return Layer.effect(CommandContext, loadCommandContext(targetDir));
}
