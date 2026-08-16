/**
 * テストから実ネットワークへ出る経路を塞ぐ vitest のセットアップ。
 *
 * GitHub API を実際に叩くテストが混ざると、未認証の枠（IP あたり 60 req/h）を CI と開発機で
 * 食い合い、他のコマンドが「レート制限」で失敗する。落ちるのは原因と無関係な場所なので
 * 追跡に時間がかかる。モックの付け忘れに即座に気づけるよう、素の `fetch` を失敗させる。
 *
 * 個別のテストは `globalThis.fetch = vi.fn()` や `vi.stubGlobal("fetch", ...)` で差し替えて
 * よい。ここで塞ぐのは差し替え忘れだけで、差し替えた経路は素通しする。
 *
 * `vitest.config.ts` の `setupFiles` から読み込む。
 */
import { afterEach, beforeEach } from "vitest";

/**
 * そのテストで素の `fetch` が呼ばれた宛先。
 *
 * 例外を投げるだけでは足りないため記録する。ziku の GitHub 呼び出しは失敗を値へ畳む
 * （`fetchCommitSha` など）ので、投げた例外はテスト対象自身に握られて「未解決」という
 * 正常な戻り値に化け、テストは通ってしまう。テスト終了時にこの記録を見て落とす。
 */
let attemptedUrls: string[] = [];

beforeEach(() => {
  attemptedUrls = [];
  // テストが差し替えた fetch を戻し忘れても、次のテストは塞がれた状態から始まる。
  globalThis.fetch = ((input: unknown) => {
    const url = typeof input === "string" ? input : ((input as { url?: string })?.url ?? "unknown");
    attemptedUrls.push(url);
    throw new Error(
      `Real network access from a test: ${url}. Mock it (globalThis.fetch = vi.fn() / vi.mock) instead of calling the live API.`,
    );
  }) as typeof fetch;
});

afterEach(() => {
  if (attemptedUrls.length === 0) return;
  const urls = attemptedUrls.join(", ");
  attemptedUrls = [];
  throw new Error(
    `Real network access from a test: ${urls}. Mock it (globalThis.fetch = vi.fn() / vi.mock) instead of calling the live API.`,
  );
});
