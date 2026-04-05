#!/usr/bin/env node
import * as p from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import { Effect } from "effect";
import { version } from "../package.json";
import { diffCommand } from "./commands/diff";
import { initCommand } from "./commands/init";
import { pullCommand } from "./commands/pull";
import { pushCommand } from "./commands/push";
import { setupCommand } from "./commands/setup";
import { trackCommand } from "./commands/track";
import { ZikuError } from "./errors";
import { intro, logZikuError, pc } from "./ui/renderer";

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
    track: trackCommand,
  },
});

type CommandType =
  | typeof initCommand
  | typeof pushCommand
  | typeof pullCommand
  | typeof diffCommand;

const commandMap: Record<"init" | "push" | "pull" | "diff", CommandType> = {
  init: initCommand,
  push: pushCommand,
  pull: pullCommand,
  diff: diffCommand,
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
    ],
  });

  if (p.isCancel(command)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const selectedCommand = commandMap[command];
  await runMain(selectedCommand as typeof diffCommand);
}

/**
 * トップレベルエラーハンドラ
 *
 * 背景: 各コマンドで throw された ZikuError をここでキャッチし、
 * @clack/prompts で統一的に表示する。process.exit(1) はこの 1 箇所のみ。
 */
async function run(): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise(async () => {
      const args = process.argv.slice(2);
      const hasSubCommand =
        args.length > 0 &&
        [
          "init",
          "setup",
          "push",
          "pull",
          "diff",
          "track",
          "--help",
          "-h",
          "--version",
          "-v",
        ].includes(args[0]);

      if (!hasSubCommand && args.length > 0 && !args[0].startsWith("-")) {
        // npx ziku . のような形式は init コマンドとして実行
        await runMain(initCommand);
      } else if (!hasSubCommand && args.length === 0) {
        // 引数なしの場合はコマンド選択プロンプトを表示
        await promptCommand();
      } else {
        await runMain(main);
      }
    }).pipe(
      Effect.catchAll((error) => {
        if (error instanceof ZikuError) {
          logZikuError(error);
          return Effect.sync(() => process.exit(1));
        }
        return Effect.fail(error);
      }),
    ),
  );
}

void run();
