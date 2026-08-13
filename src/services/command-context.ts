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
import { Cause, Context, Effect, Exit, Layer, Option, Scope } from "effect";
import type { ZikuConfig, LockState, TemplateSource } from "../modules/schemas";
import { isGitHubSource } from "../modules/schemas";
import { FileNotFoundError, ParseError, ZikuError } from "../errors";
import type { TemplateError } from "../errors";
import { loadZikuConfig, zikuConfigExists } from "../utils/ziku-config";
import { loadLock } from "../utils/lock";
import { resolveTemplateDirScoped } from "../utils/template-resolve";
import { resolveLatestCommitSha } from "../utils/github";

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
  /**
   * テンプレートの一時ディレクトリを削除する関数。
   *
   * 内部実装は Effect.Scope の close。Scope に登録された全 finalizer
   * (acquireTempTemplate の addFinalizer 等) が走るため、
   * 削除漏れが構造的に防がれる。
   */
  readonly cleanup: () => Promise<void>;
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

    // テンプレート取得を Scope に紐づける。
    //
    // 設計: Scope を手動で作り、resolveTemplateDirScoped を Scope.extend で接続する。
    // cleanup は Scope.close を呼ぶラッパー。Scope に登録された全 finalizer
    // (acquireTempTemplate の addFinalizer など) が必ず実行される。
    //
    // 失敗時の保証: resolveTemplateDirScoped が失敗すると ctx が返らないため
    // 呼び出し側は cleanup を取得できない。Effect.onError で scope を閉じて
    // finalizer (tracker 登録解除 + rmSync) を走らせる。これがないと
    // process exit まで temp dir と tracker 状態が残る。
    //
    // 成功時: 呼び出し側 (各コマンド) は従来どおり withFinally(work, cleanup) で使える。
    // cleanup を呼び忘れた場合でも、登録された tempDir は temp-tracker の
    // process.on('exit') で同期削除される (二重防衛)。
    const scope = yield* Scope.make();
    const templateDir = yield* resolveTemplateDirScoped(source, targetDir).pipe(
      Scope.extend(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const cleanup = (): Promise<void> => Effect.runPromise(Scope.close(scope, Exit.void));

    // resolveBaseRef: ソース種別の分岐を吸収
    // resolveLatestCommitSha は Promise<string | undefined> を返すため、
    // Option.fromNullable で undefined → None に正規化してから返す
    //
    // source.ref を渡す理由: テンプレートを取得したブランチと baseRef が食い違うと、
    // 3-way マージのベースが別ブランチのツリーになる。
    const resolveBaseRef = isGitHubSource(source)
      ? Effect.tryPromise(() => resolveLatestCommitSha(source.owner, source.repo, source.ref)).pipe(
          Effect.map(Option.fromNullable),
          Effect.orElseSucceed(() => Option.none<string>()),
        )
      : Effect.succeed(Option.none<string>());

    return { config, lock, source, templateDir, cleanup, resolveBaseRef };
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
