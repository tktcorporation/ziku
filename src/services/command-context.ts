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
import { ZikuError, zikuFailure } from "../errors";
import type {
  FileNotFoundError,
  ParseError,
  TemplateError,
  ValidationError,
  ZikuFailure,
} from "../errors";
import { loadZikuConfig } from "../utils/ziku-config";
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

/** loadCommandContext / loadLock が返しうる、ユーティリティ層の失敗。 */
export type ContextLoadError = FileNotFoundError | ParseError | ValidationError | TemplateError;

// ─── Effect ヘルパー ───

/**
 * コマンドのエントリポイントで Effect を実行する。
 *
 * Effect.runPromise は失敗を FiberFailure でラップするため、そのままでは
 * トップレベルハンドラ（index.ts）が失敗の種類を判別できない。この関数は Exit から
 * 失敗値を取り出して素通しで再スローし、`ZikuFailure` の `reason` と `cause` を
 * 呼び出し元まで届ける。
 *
 * 使い方:
 *   await runCommandEffect(
 *     loadCommandContext(targetDir).pipe(Effect.mapError(toZikuFailure)),
 *   );
 */
export async function runCommandEffect<A>(
  effect: Effect.Effect<A, ZikuFailure | ZikuError>,
): Promise<A> {
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
): Effect.Effect<CommandContextShape, ContextLoadError> {
  return Effect.gen(function* () {
    const { config } = yield* loadZikuConfig(targetDir);

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
    // 成功時: 呼び出し側 (各コマンド) は withCleanup / withFinally に cleanup を渡す。
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
): Layer.Layer<CommandContext, ContextLoadError> {
  return Layer.effect(CommandContext, loadCommandContext(targetDir));
}

/**
 * ユーティリティ層の失敗を `FailureReason` へ分類する。
 *
 * スキーマ違反（ValidationError）はファイル不在と別ケースにする。読めない設定ファイルを
 * 「見つからない」と報告すると、ユーザーは存在するファイルを探し続けることになる。
 *
 * 元の例外は cause で繋ぐ。分類しても発生源を追えるようにするため。
 */
export function toZikuFailure(err: ContextLoadError): ZikuFailure {
  return match(err)
    .with({ _tag: "FileNotFoundError" }, (e) =>
      zikuFailure({ kind: "NotInitialized", path: e.path }),
    )
    .with({ _tag: "ParseError" }, (e) =>
      zikuFailure(
        { kind: "ConfigUnparsable", path: e.path, detail: String(e.cause) },
        { cause: e.cause },
      ),
    )
    .with({ _tag: "ValidationError" }, (e) =>
      zikuFailure({ kind: "ConfigInvalid", path: e.path, issues: e.issues }),
    )
    .with({ _tag: "TemplateError" }, (e) =>
      zikuFailure({ kind: "TemplateUnavailable", detail: e.message }, { cause: e.cause }),
    )
    .exhaustive();
}

/**
 * 分類した失敗を `ZikuError` へ落とす。`throw` で失敗を伝えるコマンド
 * (pull / push / status) が使う。文言は `toZikuFailure` と同じ SSOT から来る。
 */
export function toZikuError(err: ContextLoadError): ZikuError {
  const failure = toZikuFailure(err);
  return new ZikuError(failure.message, failure.hint);
}
