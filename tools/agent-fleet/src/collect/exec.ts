import { fail, ok, type SourceResult } from './types';

// 失敗は投げずに分類して返す。呼び出し元は源ごとに独立して失敗を扱うため。
export async function runCommand(cmd: string[], timeoutMs: number): Promise<SourceResult<string>> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // detached: true で子を新しいプロセスグループの leader にする（POSIX の setsid 相当）。
    // 孫プロセスもこのグループに属するため、後述のグループ kill で一緒に後始末できる。
    proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', detached: true });
  } catch (e) {
    // バイナリが無い（ENOENT）は「その源が動いていない」と同じ扱いにする
    return fail('not_running', `${cmd[0]}: ${(e as Error).message}`);
  }

  let timer: ReturnType<typeof setTimeout>;
  // proc.kill() は直接の子プロセスにしか効かない。孫プロセスが標準出力の書き込み側を
  // 握ったまま生き残ると stream の読み取りが終わらず、collect 側の Promise が孫の終了
  // まで宙に浮いてポーリングのたびに積み上がる。プロセスグループ全体へ signal を送って
  // 孫ごと終わらせ、呼び出し元は締め切りを Promise.race で確定させて待たされない。
  const deadline = new Promise<SourceResult<string>>((resolve) => {
    timer = setTimeout(() => {
      // 負の pid はプロセスグループ全体への signal（POSIX）。setsid していない環境
      // （Windows 等）では失敗しうるので、直接の子への kill を fallback として残す。
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill();
      }
      resolve(fail('timeout', `${cmd.join(' ')} が ${timeoutMs}ms で応答しなかった`));
    }, timeoutMs);
  });

  const collect = (async (): Promise<SourceResult<string>> => {
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      if (code !== 0) return fail('not_running', `${cmd.join(' ')}: ${stderr.trim() || `exit ${code}`}`);
      return ok(stdout);
    } catch (e) {
      // ストリーム読み取り自体の失敗（プロセス強制終了によるパイプ破棄など）も
      // 「その源が動いていない」として分類する
      return fail('not_running', `${cmd.join(' ')}: ${(e as Error).message}`);
    }
  })();

  try {
    return await Promise.race([deadline, collect]);
  } finally {
    clearTimeout(timer!);
  }
}
