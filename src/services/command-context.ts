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
import type { AbsPath, CommitSha, ZikuConfig, LockState, TemplateSource } from "../modules/schemas";
import { zikuFailure } from "../errors";
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
import type { CommitShaResolution } from "../utils/github";
import { resolveSourceCommit } from "../utils/github";

// ─── Service 定義 ───

export interface CommandContextShape {
  /** ziku.jsonc のパターン定義 */
  readonly config: ZikuConfig;
  /** lock.json の同期状態（source 含む） */
  readonly lock: LockState;
  /** テンプレートの取得元（lock.source のエイリアス） */
  readonly source: TemplateSource;
  /** 解決済みテンプレートディレクトリのパス */
  readonly templateDir: AbsPath;
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
   * GitHub ソースの場合は API で SHA を取得。ローカルソースの場合は None を返す。
   * ソース種別の分岐を吸収し、呼び出し元はソース種別を意識せずに使える。
   *
   * 失敗するのはトークンが拒否されたときだけ。振り分けの理由は {@link toBaseRef} を参照。
   */
  readonly resolveBaseRef: Effect.Effect<Option.Option<CommitSha>, ZikuFailure>;
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
export async function runCommandEffect<A>(effect: Effect.Effect<A, ZikuFailure>): Promise<A> {
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
  targetDir: AbsPath,
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
    // 成功時: 呼び出し側 (各コマンド) は withCleanup に cleanup を渡す。
    // cleanup を呼び忘れた場合でも、登録された tempDir は temp-tracker の
    // process.on('exit') で同期削除される (二重防衛)。
    const scope = yield* Scope.make();
    const templateDir = yield* resolveTemplateDirScoped(source, targetDir).pipe(
      Scope.extend(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const cleanup = (): Promise<void> => Effect.runPromise(Scope.close(scope, Exit.void));

    // resolveBaseRef: ソース種別の分岐を吸収する。
    //
    // source.ref を渡す理由: テンプレートを取得した ref とベースの SHA が食い違うと、
    // 3-way マージのベースが別ブランチのツリーになる。
    //
    // Effect.promise を使うのは、resolveSourceCommit が失敗を戻り値で表すため。
    // reject するのは実装の不具合なので、defect として運ぶ。
    const resolveBaseRef = match(source)
      .with({ kind: "github" }, (gh) =>
        Effect.promise(() => resolveSourceCommit(gh.owner, gh.repo, gh.ref)).pipe(
          Effect.flatMap(toBaseRef),
        ),
      )
      .with({ kind: "local" }, () => Effect.succeed(Option.none<CommitSha>()))
      .exhaustive();

    return { config, lock, source, templateDir, cleanup, resolveBaseRef };
  });
}

/**
 * コミット SHA の解決結果を、同期ベースとして使える形へ変換する。
 *
 * 失敗として返すのは認証拒否だけ。トークンが拒否されている間は何度取り直しても SHA は
 * 取れないので、記録済みの古いベースへ黙って倒すと、共通祖先が実際のテンプレートから
 * 離れたまま 3-way マージが動き続ける。ユーザーはトークンを直せば復帰できるので、
 * その判断材料を失敗として渡す。
 *
 * それ以外（ネットワーク断・レート制限・ref が見つからない）は None を返し、呼び出し側が
 * 記録済みのベースへ倒せるようにする。時間を置けば解消しうる失敗でコマンド全体を止めると、
 * SHA を引けないだけで取り込み自体は成功している実行まで巻き添えになる。
 */
function toBaseRef(
  resolution: CommitShaResolution,
): Effect.Effect<Option.Option<CommitSha>, ZikuFailure> {
  return match(resolution)
    .with({ _tag: "Resolved" }, (r) => Effect.succeedSome(r.sha))
    .with({ _tag: "AuthRejected" }, (r) =>
      Effect.fail(zikuFailure({ kind: "GitHubAuthRejected", detail: r.detail })),
    )
    .with({ _tag: "Unresolved" }, () => Effect.succeed(Option.none<CommitSha>()))
    .exhaustive();
}

/**
 * CommandContext の Layer を構築する。
 */
export function makeCommandContextLayer(
  targetDir: AbsPath,
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
