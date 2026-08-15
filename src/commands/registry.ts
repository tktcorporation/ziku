/**
 * citty へ登録するサブコマンドの実体を、名前から引ける形で 1 箇所にまとめた登録簿。
 *
 * CLI の入口（`src/index.ts`）と README の `## Commands` 生成（`scripts/generate-readme.ts`）が
 * どちらもこの 1 本を見る。生成側が自前でコマンドを並べると、登録したのに usage を書き忘れた
 * コマンドがドキュメントから黙って落ち、生成物と commit 済みを比べる `docs:check` でも
 * 差分が出ないため気づけない。
 *
 * `satisfies Record<SubCommandName, unknown>` で名前一覧（{@link SUBCOMMAND_NAMES}）との一致を
 * 型に検査させる。登録したのに名前一覧へ足し忘れる（= メニューに出ない・打ち間違い判定の
 * 対象外になる）ことと、逆に一覧だけに書いて登録し忘れることの両方がコンパイルエラーになる。
 * `unknown` へ潰さないのは、各コマンドの `ArgsDef` を保ったまま `renderUsage` へ渡すため。
 *
 * `src/index.ts` ではなくこのモジュールが持つ理由: エントリポイントはモジュール本体で CLI を
 * 起動するので、ドキュメント生成が import すると生成の途中で CLI が走ってしまう。
 */
import { diffCommand } from "./diff";
import { initCommand } from "./init";
import { pullCommand } from "./pull";
import { pushCommand } from "./push";
import { setupCommand } from "./setup";
import { statusCommand } from "./status";
import { trackCommand } from "./track";
import type { SubCommandName } from "./names";

export const subCommands = {
  init: initCommand,
  setup: setupCommand,
  push: pushCommand,
  pull: pullCommand,
  diff: diffCommand,
  status: statusCommand,
  track: trackCommand,
} satisfies Record<SubCommandName, unknown>;
