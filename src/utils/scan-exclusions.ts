/**
 * ディスクを歩くときに入らないディレクトリ。
 *
 * 依存パッケージと git のオブジェクトデータベースは同期の対象にならないので、その中に
 * 何があっても走査には要らない。除かないと、数万ファイルを持つ `node_modules` を
 * `.gitignore` 1 本や追跡候補を探すためだけに全走査することになる。
 *
 * 走る経路が増えても同じ集合を見るように、定義をここ 1 つにする。消費側の API に合わせて
 * 片方は名前の集合、もう片方は glob 文字列で書くと、片方だけに増やしたときにもう片方が
 * 歩き続ける。
 */
export const UNSCANNED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/**
 * {@link UNSCANNED_DIRS} を glob の除外パターンとして表したもの。
 *
 * 走査を glob に任せる経路（tinyglobby）用。名前の集合から導くので、片方だけが古くならない。
 */
export const UNSCANNED_GLOBS: readonly string[] = [...UNSCANNED_DIRS].map((dir) => `**/${dir}/**`);
