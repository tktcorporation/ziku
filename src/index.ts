#!/usr/bin/env node
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
import { statusCommand } from "./commands/status";
import { trackCommand } from "./commands/track";
import { ZikuError, ZikuFailure } from "./errors";
import { intro, logUnexpectedError, logZikuError, pc } from "./ui/renderer";

const main = defineCommand({
  meta: {
    name: "ziku",
    version,
    description: "Dev environment template manager",
  },
  subCommands: {
    init: initCommand,
    setup: setupCommand,
    push: pushCommand,
    pull: pullCommand,
    diff: diffCommand,
    status: statusCommand,
    track: trackCommand,
  },
});

type CommandType =
  | typeof initCommand
  | typeof pushCommand
  | typeof pullCommand
  | typeof diffCommand
  | typeof statusCommand;

const commandMap: Record<"init" | "push" | "pull" | "diff" | "status", CommandType> = {
  init: initCommand,
  push: pushCommand,
  pull: pullCommand,
  diff: diffCommand,
  status: statusCommand,
};

/**
 * コマンド選択プロンプト
 *
 * 背景: 引数なしで実行された場合に、ユーザーにコマンドを選択してもらう。
 * @inquirer/prompts の select を @clack/prompts に置き換え。
 */
async function promptCommand(): Promise<void> {
  intro();

  p.log.message(pc.dim(`Run ${pc.cyan("ziku <command> --help")} for non-interactive usage.`));

  const command = await p.select({
    message: "What would you like to do?",
    options: [
      {
        value: "init" as const,
        label: "init",
        hint: "Apply template to your project",
      },
      {
        value: "push" as const,
        label: "push",
        hint: "Push local changes as a PR",
      },
      {
        value: "pull" as const,
        label: "pull",
        hint: "Pull latest template updates",
      },
      {
        value: "diff" as const,
        label: "diff",
        hint: "Show differences from template",
      },
      {
        value: "status" as const,
        label: "status",
        hint: "Show pending pull/push and recommend next action",
      },
    ],
  });

  if (p.isCancel(command)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const selectedCommand = commandMap[command];
  await runCli(selectedCommand as typeof diffCommand, []);
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

/** 引数から実行するコマンドを選び、citty に渡す。 */
async function dispatch(): Promise<void> {
  const args = process.argv.slice(2);
  const hasSubCommand =
    args.length > 0 &&
    [
      "init",
      "setup",
      "push",
      "pull",
      "diff",
      "status",
      "track",
      "--help",
      "-h",
      "--version",
      "-v",
    ].includes(args[0]);

  if (!hasSubCommand && args.length > 0 && !args[0].startsWith("-")) {
    // npx ziku . のような形式は init コマンドとして実行
    await runCli(initCommand, args);
    return;
  }
  if (!hasSubCommand && args.length === 0) {
    // 引数なしの場合はコマンド選択プロンプトを表示
    await promptCommand();
    return;
  }
  await runCli(main, args);
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
 * ziku が予期した失敗（ZikuFailure / ZikuError）と、引数の解釈で弾かれた入力は
 * message + hint だけを見せる。それ以外は ziku 側の不具合なので、原因を握り潰さず
 * スタックトレースごと見せる。
 */
function report(error: unknown): void {
  match(error)
    .with(P.union(P.instanceOf(ZikuFailure), P.instanceOf(ZikuError)), logZikuError)
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
