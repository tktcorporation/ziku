/**
 * コマンド共通コンテキスト — Effect Service パターン
 *
 * 背景: pull/push/diff で繰り返される「設定読み込み → テンプレート解決 → クリーンアップ」を
 * Effect の Service として DRY 化する。各コマンドは loadCommandContext を yield* するだけで
 * 設定・lock・テンプレートディレクトリが手に入る。
 *
 * ソース種別の分岐もここで吸収し、resolveBaseRef で透過的にベースリビジョンを解決する。
 */
import { Cause, Context, Effect, Exit, Layer, Option, Scope } from "effect";
import { match } from "ts-pattern";
import type { ZikuConfig, LockState, TemplateSource } from "../modules/schemas";
import { FileNotFoundError, ParseError, ZikuError } from "../errors";
import type { TemplateError, ValidationError } from "../errors";
import { loadZikuConfig, zikuConfigExists } from "../utils/ziku-config";
import { loadLock } from "../utils/lock";
import { resolveTemplateDirScoped } from "../utils/template-resolve";
import { resolveSourceCommitSha } from "../utils/github";

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
   * GitHub ソースの場合は API で SHA を取得。
   * ローカルソースの場合は None を返す。ソース種別の分岐を吸収し、呼び出し元は
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
): Effect.Effect<
  CommandContextShape,
  FileNotFoundError | ParseError | ValidationError | TemplateError
> {
  return Effect.gen(function* () {
    if (!zikuConfigExists(targetDir)) {
      return yield* new FileNotFoundError({ path: ".ziku/ziku.jsonc" });
    }
    const { config } = yield* Effect.tryPromise({
      try: () => loadZikuConfig(targetDir),
      catch: (e) => new ParseError({ path: ".ziku/ziku.jsonc", cause: e }),
    });

    const lock = yield* loadLock(targetDir);

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
    // resolveSourceCommitSha は Promise<string | undefined> を返すため、
    // Option.fromNullable で undefined → None に正規化してから返す
    //
    // source.ref を渡す理由: テンプレートを取得した ref とベースの SHA が食い違うと、
    // 3-way マージのベースが別ブランチのツリーになる。
    const resolveBaseRef = match(source)
      .with({ kind: "github" }, (gh) =>
        Effect.tryPromise(() => resolveSourceCommitSha(gh.owner, gh.repo, gh.ref)).pipe(
          Effect.map(Option.fromNullable),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
      )
      .with({ kind: "local" }, () => Effect.succeed(Option.none<string>()))
      .exhaustive();

    return { config, lock, source, templateDir, cleanup, resolveBaseRef };
  });
}

/**
 * CommandContext の Layer を構築する。
 */
export function makeCommandContextLayer(
  targetDir: string,
): Layer.Layer<CommandContext, FileNotFoundError | ParseError | ValidationError | TemplateError> {
  return Layer.effect(CommandContext, loadCommandContext(targetDir));
}

/**
 * loadCommandContext のエラーを ZikuError に変換するヘルパー。
 *
 * 各コマンドで繰り返される mapError パターンを DRY 化。
 *
 * スキーマ違反（ValidationError）はファイル不在と別文言にする。読めない設定ファイルを
 * 「見つからない」と報告すると、ユーザーは存在するファイルを探し続けることになる。
 */
export function toZikuError(
  err: FileNotFoundError | ParseError | ValidationError | TemplateError,
): ZikuError {
  return match(err)
    .with(
      { _tag: "FileNotFoundError" },
      (e) => new ZikuError(`${e.path} not found.`, "Run 'ziku init' first."),
    )
    .with(
      { _tag: "ParseError" },
      (e) => new ZikuError(`Failed to parse ${e.path}`, String(e.cause)),
    )
    .with(
      { _tag: "ValidationError" },
      (e) =>
        new ZikuError(
          `Failed to read ${e.path}`,
          [...e.issues, "Run `ziku init` to recreate it."].join("\n"),
        ),
    )
    .with({ _tag: "TemplateError" }, (e) => new ZikuError("Failed to load template", e.message))
    .exhaustive();
}
