/**
 * ziku が持つサブコマンド名の単一の情報源（SSOT）。
 *
 * CLI の入口（引数解釈・対話メニュー）とドキュメント生成の双方がこの 1 本を見る。
 * それぞれが自前の一覧を持つと、片方にだけコマンドを足したときに「メニューから辿れない
 * コマンド」や「ドキュメントから黙って消えるコマンド」が生まれる。
 *
 * 型と定数だけを置くのは、コマンド実装からもドキュメント生成からも依存できるようにする
 * ため（実装を持つモジュールに置くと循環依存になる）。
 */

export const SUBCOMMAND_NAMES = [
  "init",
  "setup",
  "push",
  "pull",
  "diff",
  "status",
  "track",
  "aggregate",
] as const;

export type SubCommandName = (typeof SUBCOMMAND_NAMES)[number];
