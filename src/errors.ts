/**
 * ユーザー向けエラー。hint でリカバリ方法を提示する。
 *
 * 背景: process.exit(1) が各コマンドに散在していたのを解消するため導入。
 * 各コマンドは BermError を throw し、cli.ts のトップレベルで catch して
 * @clack/prompts の log.error() で統一的に表示する。
 * process.exit(1) は cli.ts の 1 箇所のみに制限。
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
