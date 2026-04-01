/**
 * アプリケーションエラー型定義
 *
 * 背景: try/catch ベースのエラーハンドリングを段階的に Effect の型付きエラーチャネルに移行。
 *
 * BermError: ユーザー向けエラー。従来通り throw → catch パターンで使用。
 *   Effect 化が完了するまでの過渡期に、コマンド層で throw される。
 *
 * Tagged errors: Effect のエラーチャネル用。Effect<A, E> の E として型レベルで追跡される。
 *   ユーティリティ関数が返す Effect の失敗型として使用する。
 */
import { Data } from "effect";

/**
 * ユーザー向けエラー。hint でリカバリ方法を提示する。
 *
 * 背景: 各コマンドは BermError を throw し、cli.ts のトップレベルで catch して
 * @clack/prompts の log.error() で統一的に表示する。
 * process.exit(1) は cli.ts の 1 箇所のみに制限。
 *
 * 注意: Effect 化が完了した後は TaggedError に移行予定。現時点では
 * throw で使われる箇所が多いため、Error ベースを維持する。
 */
export class BermError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "BermError";
  }
}

// ────────────────────────────────────────────────────────────────
// Effect Tagged Errors — ユーティリティ関数の型付きエラーチャネル用
// ────────────────────────────────────────────────────────────────

/** ファイルが見つからない */
export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly path: string;
}> {}

/** JSONC/JSON パースに失敗 */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/** Zod スキーマバリデーション失敗 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly path: string;
  readonly issues: readonly string[];
}> {}

/** GitHub API エラー */
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly message: string;
  readonly status?: number;
}> {}

/** Git 操作エラー */
export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string;
}> {}

/** テンプレートダウンロード・操作エラー */
export class TemplateError extends Data.TaggedError("TemplateError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
