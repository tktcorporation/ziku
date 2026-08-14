#!/usr/bin/env node
import { statSync } from "node:fs";
import * as p from "@clack/prompts";
import { defineCommand, runCommand, runMain } from "citty";
import type { ArgsDef, CommandDef } from "citty";
import { Cause, Effect, Exit } from "effect";
import { P, match } from "ts-pattern";
import { version } from "../package.json";
import { diffCommand } from "./commands/diff";
import { initCommand } from "./commands/init";
import { pullCommand } from "./commands/pull";
import { pushCommand } from "./commands/push";
import { setupCommand } from "./commands/setup";
import { SUBCOMMAND_NAMES, type SubCommandName } from "./commands/names";
import { statusCommand } from "./commands/status";
import { trackCommand } from "./commands/track";
import { ZikuFailure, zikuFailure } from "./errors";
import { intro, logUnexpectedError, logZikuError, pc } from "./ui/renderer";

const main = defineCommand({
  meta: {
    name: "ziku",
    version,
    description: "Dev environment template manager",
  },
  // `satisfies` で SUBCOMMAND_NAMES との一致を型に検査させる。citty へ登録したのに
  // 名前一覧へ足し忘れる（= メニューに出ない・打ち間違い判定の対象外になる）ことと、
  // 逆に一覧だけに書いて登録し忘れることの両方がコンパイルエラーになる。
  subCommands: {
    init: initCommand,
    setup: setupCommand,
    push: pushCommand,
    pull: pullCommand,
    diff: diffCommand,
    status: statusCommand,
    track: trackCommand,
  } satisfies Record<SubCommandName, unknown>,
});

function isSubCommandName(value: string): value is SubCommandName {
  return (SUBCOMMAND_NAMES as readonly string[]).includes(value);
}

/**
 * 対話メニューに出す各コマンドの一行説明。
 *
 * `Record<SubCommandName, string>` なのでコマンドを追加すると説明の追加が強制され、
 * メニューに載り損ねることがない。
 */
const COMMAND_HINTS: Record<SubCommandName, string> = {
  init: "Apply template to your project",
  setup: "Turn a repository into a ziku template",
  push: "Push local changes to the template",
  pull: "Pull latest template updates",
  diff: "Show differences from template",
  status: "Show pending pull/push and recommend next action",
  track: "Add file patterns to the sync whitelist",
};

/**
 * メニューで選ばれたサブコマンドを実行する。
 *
 * init / setup / push / pull / diff / status は位置引数がプロジェクトディレクトリだけで、
 * 既定値のカレントディレクトリを対象に動く。メニューはそのまま引数なしで起動してよい。
 * track だけは位置引数が「include に足すパターン」で、既定値を置きようがない（足すものが
 * 決まらなければコマンドが成り立たない）。引数なしで起動すると必ず `MissingArgument` に
 * なるので、起動する前にパターンを尋ねる。
 *
 * 名前からコマンド定義への対応を `Record` に畳まない理由: コマンドごとに args スキーマ
 * （`ArgsDef`）が違うため、1 つの `Record` に入れると全コマンドが 1 つの型へ潰れ、
 * `runCli` の型引数が実際の定義とずれる。名前ごとに `runCli` を呼び分ければ、
 * 各コマンドの `ArgsDef` がそのまま推論される。
 */
function runSelectedCommand(name: SubCommandName): Promise<void> {
  return match(name)
    .with("init", () => runCli(initCommand, []))
    .with("setup", () => runCli(setupCommand, []))
    .with("push", () => runCli(pushCommand, []))
    .with("pull", () => runCli(pullCommand, []))
    .with("diff", () => runCli(diffCommand, []))
    .with("status", () => runCli(statusCommand, []))
    .with("track", async () => runCli(trackCommand, await promptTrackPatterns()))
    .exhaustive();
}

/**
 * `track` に渡すパターンを尋ねる。
 *
 * 空白区切りだけを受け付ける。glob の brace 展開（`.claude/rules/*.{md,json}`）はコンマを
 * 含むため、コンマも区切りにすると 1 つのパターンが 2 つに割れる。
 */
async function promptTrackPatterns(): Promise<string[]> {
  const answer = await p.text({
    message: "Which files should ziku track?",
    placeholder: ".claude/rules/*.md .mcp.json",
    validate: (value) =>
      splitPatterns(value).length === 0
        ? "Enter one or more paths or glob patterns, separated by spaces."
        : undefined,
  });

  if (p.isCancel(answer)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return splitPatterns(answer);
}

/** 空白区切りの入力をパターン列にする。 */
function splitPatterns(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter((pattern) => pattern.length > 0);
}

/**
 * コマンド選択プロンプト
 *
 * 背景: 引数なしで実行された場合に、ユーザーにコマンドを選択してもらう。
 */
async function promptCommand(): Promise<void> {
  intro();

  p.log.message(pc.dim(`Run ${pc.cyan("ziku <command> --help")} for non-interactive usage.`));

  const command = await p.select({
    message: "What would you like to do?",
    options: SUBCOMMAND_NAMES.map((name) => ({
      value: name,
      label: name,
      hint: COMMAND_HINTS[name],
    })),
  });

  if (p.isCancel(command)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  await runSelectedCommand(command);
}

/**
 * citty が usage / version の描画に入る引数か判定する。
 *
 * citty の判定条件をそのまま写している。`-v` は diff の `--verbose` の別名でもあるため、
 * 単独で渡されたときだけバージョン表示として扱う。ここを緩めると `ziku diff -v` が
 * バージョン表示側の経路に流れ、失敗の報告経路を失う。
 */
function isUsageOrVersionRequest(rawArgs: string[]): boolean {
  if (rawArgs.some((arg) => arg === "--help" || arg === "-h")) return true;
  return rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v");
}

/**
 * citty のコマンドを実行する。
 *
 * 実行系で `runMain` を使わない理由: `runMain` は例外を自前で握って `console.error` に
 * オブジェクトをダンプして終了するため、失敗がトップレベルハンドラに届かず、
 * ユーザーには内部表現がそのまま見えてしまう。`runCommand` は例外をそのまま投げる。
 *
 * usage / version の描画だけは `runMain` に任せる。サブコマンドを解決して usage を
 * 描く処理は citty の内部にしかなく、こちらで再実装すると表示がずれる。
 */
async function runCli<T extends ArgsDef>(cmd: CommandDef<T>, rawArgs: string[]): Promise<void> {
  if (isUsageOrVersionRequest(rawArgs)) {
    await runMain(cmd, { rawArgs });
    return;
  }
  await runCommand(cmd, { rawArgs });
}

/**
 * サブコマンド名の打ち間違いとみなす編集距離の上限。
 *
 * 2 は「1 文字の脱字・余分・入れ替えが 2 箇所まで」に相当する。サブコマンド名は 4〜6 文字
 * なので、これ以上広げると無関係なディレクトリ名まで打ち間違い扱いになる。
 */
const MAX_SUBCOMMAND_TYPO_DISTANCE = 2;

/**
 * 引数がディレクトリ指定であることが表記から確定するか判定する。
 *
 * `npx ziku .` / `npx ziku ./my-project` を init として動かすための判定。パス区切りや
 * カレント／親ディレクトリ、ホーム記法を含む文字列はサブコマンド名になりえないので、
 * 打ち間違い判定にかけずそのまま init のディレクトリとして渡す。
 */
function looksLikePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

/**
 * 引数がディレクトリとして実在するか判定する。
 *
 * `dist` や `dish` のような、ありふれていてサブコマンド名とも編集距離が近い名前を打ち間違い
 * 扱いにしないための判定。実在するディレクトリを指しているなら、それは `ziku <dir>` の init
 * ショートハンドであって打ち間違いではない。
 *
 * `throwIfNoEntry: false` が畳むのは不在（ENOENT）だけで、パスに使えないバイトを含む・
 * 名前が長すぎるといった入力は例外で飛ぶ。それを ziku の不具合として報告すると、ユーザーには
 * 入力ミスに対してスタックトレースが出る。失敗はすべて「ディレクトリではない」に倒し、
 * 後続の打ち間違い判定と init へ入力をそのまま流す。
 */
function isExistingDirectory(value: string): boolean {
  return Effect.runSync(
    Effect.try(() => statSync(value, { throwIfNoEntry: false })?.isDirectory() === true).pipe(
      // 失敗は「ディレクトリではない」という答えそのものなので握り潰しにならない。
      Effect.orElseSucceed(() => false),
    ),
  );
}

/** 2 つの文字列の Levenshtein 距離（挿入・削除・置換の最小回数）。 */
function editDistance(a: string, b: string): number {
  // 直前の行だけを保持する DP。row[j] は「a の先頭 i 文字」と「b の先頭 j 文字」の距離。
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, substitution);
    }
    row = next;
  }
  return row[b.length];
}

/**
 * サブコマンド名の打ち間違い候補を返す。候補が無ければ空配列。
 *
 * 第 1 引数がサブコマンド名でもフラグでもないとき、ziku はそれを init の対象ディレクトリ
 * として扱う。この経路は `ziku pul` のような打ち間違いも受け取り、存在しないディレクトリを
 * 作ってテンプレートを展開してしまう。init へ流す前にここで候補を探す。
 *
 * 判定基準（この順に見る）:
 * 1. `looksLikePath` が真ならディレクトリ指定が確定なので候補なし
 * 2. その名前のディレクトリが実在するならディレクトリ指定なので候補なし。距離より実在を先に
 *    見るのは、`ziku dist` のように既存ディレクトリ名がサブコマンド名（`diff`）と近いだけの
 *    ケースで init ショートハンドを潰さないため
 * 3. 小文字化した入力とサブコマンド名の編集距離が `MAX_SUBCOMMAND_TYPO_DISTANCE` 以下なら候補
 * 4. 候補が複数あるときは距離が最小のものだけを返す
 *
 * 打ち間違いではなく、まだ存在しない名前のディレクトリを作りたい場合のために、案内側では
 * `ziku init <name>` という逃げ道を示す。
 */
function nearestSubCommands(value: string): SubCommandName[] {
  if (looksLikePath(value) || isExistingDirectory(value)) return [];

  const normalized = value.toLowerCase();
  const candidates = SUBCOMMAND_NAMES.map((name) => ({
    name,
    distance: editDistance(normalized, name),
  })).filter((c) => c.distance <= MAX_SUBCOMMAND_TYPO_DISTANCE);

  const best = Math.min(...candidates.map((c) => c.distance));
  return candidates.filter((c) => c.distance === best).map((c) => c.name);
}

/** 打ち間違い候補を提示して中断する失敗値を作る。 */
function typoFailure(value: string, suggestions: SubCommandName[]): ZikuFailure {
  const commands = suggestions.map((s) => `\`ziku ${s}\``).join(" or ");
  return zikuFailure({
    kind: "InvalidArgument",
    argument: "command",
    value,
    expected: `${commands}. To create a project directory named "${value}" instead, run \`ziku init ${value}\`.`,
  });
}

/** 引数から実行するコマンドを選び、citty に渡す。 */
async function dispatch(): Promise<void> {
  const args = process.argv.slice(2);
  const [first] = args;

  // 引数なしの場合はコマンド選択プロンプトを表示
  if (first === undefined) {
    await promptCommand();
    return;
  }

  // サブコマンド名とフラグ（`--help` / `--version` を含む）は citty の解決に任せる
  if (first.startsWith("-") || isSubCommandName(first)) {
    await runCli(main, args);
    return;
  }

  const suggestions = nearestSubCommands(first);
  if (suggestions.length > 0) {
    throw typoFailure(first, suggestions);
  }

  // npx ziku . のような形式は init コマンドとして実行
  await runCli(initCommand, args);
}

/**
 * citty が引数の解釈で投げるエラーか判定する。
 *
 * 未知のサブコマンドや必須引数の欠落は ziku の不具合ではなくユーザーの入力ミスなので、
 * 予期しないエラーとしてスタックトレースを出すのではなく、使い方を案内する。
 */
function isUsageError(error: unknown): error is Error {
  return error instanceof Error && error.name === "CLIError";
}

/**
 * 失敗を表示する。
 *
 * ziku が予期した失敗（ZikuFailure）と、引数の解釈で弾かれた入力は message + hint だけを
 * 見せる。それ以外は ziku 側の不具合なので、原因を握り潰さずスタックトレースごと見せる。
 */
function report(error: unknown): void {
  match(error)
    .with(P.instanceOf(ZikuFailure), logZikuError)
    .when(isUsageError, (e) =>
      logZikuError({ message: e.message, hint: "Run `ziku --help` to see available commands." }),
    )
    .otherwise(logUnexpectedError);
}

/**
 * トップレベルエラーハンドラ。
 *
 * `runPromiseExit` は失敗でも reject しないため、どのコマンドがどう失敗しても
 * unhandled rejection にならない。`Cause.squash` で失敗値と defect（Zod の例外や
 * Effect.orDie で落ちたもの）を同じ経路に集め、表示してから終了コード 1 で終える。
 * process.exit(1) はこの 1 箇所のみ。
 */
async function run(): Promise<void> {
  const exit = await Effect.runPromiseExit(Effect.promise(dispatch));
  if (Exit.isSuccess(exit)) return;

  report(Cause.squash(exit.cause));
  process.exit(1);
}

void run();
