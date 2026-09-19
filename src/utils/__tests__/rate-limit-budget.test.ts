import { describe, expect, it } from "vitest";
import {
  ESTIMATED_REQUESTS_PER_CANDIDATE,
  RATE_LIMIT_SAFETY_MARGIN,
  cannotAffordRemainingRequests,
  candidateLimitFromRemaining,
  mergeObservedRateLimit,
  rateLimitSkipReason,
} from "../rate-limit-budget";

describe("candidateLimitFromRemaining", () => {
  it("安全マージンを引いた残りを、候補あたりの想定リクエスト数で割った値を返す（端数は切り捨て）", () => {
    // マージンを引いた残りが「5 件分 + 1」になるように残量を作り、切り捨てで 5 になることを見る。
    const remaining = RATE_LIMIT_SAFETY_MARGIN + ESTIMATED_REQUESTS_PER_CANDIDATE * 5 + 1;
    expect(candidateLimitFromRemaining(remaining)).toBe(5);
  });

  it("残量がマージン以下なら 0 を返す（負にはならない）", () => {
    expect(candidateLimitFromRemaining(RATE_LIMIT_SAFETY_MARGIN)).toBe(0);
    expect(candidateLimitFromRemaining(0)).toBe(0);
  });

  it("換算後の候補数上限が 1 件以上まかなえるぎりぎりの残量では 1 を返す", () => {
    const remaining = RATE_LIMIT_SAFETY_MARGIN + ESTIMATED_REQUESTS_PER_CANDIDATE;
    expect(candidateLimitFromRemaining(remaining)).toBe(1);
    expect(candidateLimitFromRemaining(remaining - 1)).toBe(0);
  });
});

describe("cannotAffordRemainingRequests", () => {
  it("観測残量が、自分自身を含む残り件数分の想定リクエスト数を下回るなら true を返す", () => {
    // 残り 0 件（自分自身のみ）、1 件あたり想定リクエスト数の必要見積もりは 1 件分。
    expect(
      cannotAffordRemainingRequests(
        ESTIMATED_REQUESTS_PER_CANDIDATE - 1,
        0,
        ESTIMATED_REQUESTS_PER_CANDIDATE,
      ),
    ).toBe(true);
    expect(
      cannotAffordRemainingRequests(
        ESTIMATED_REQUESTS_PER_CANDIDATE,
        0,
        ESTIMATED_REQUESTS_PER_CANDIDATE,
      ),
    ).toBe(false);
  });

  it("安全マージンを引かない（candidateLimitFromRemaining とは別の判定基準）", () => {
    // マージン込みなら 0 と判定されうる残量でも、動的ブレーキは必要見積もりぶんだけを見る。
    const remaining = ESTIMATED_REQUESTS_PER_CANDIDATE;
    expect(cannotAffordRemainingRequests(remaining, 0, ESTIMATED_REQUESTS_PER_CANDIDATE)).toBe(
      false,
    );
  });

  it("残り件数が多いほど、まかなえないと判定される残量のしきい値が上がる", () => {
    // 残り 3 件（自分自身を含め 4 件分）の必要見積もりは 4 件分。
    const required = 4 * ESTIMATED_REQUESTS_PER_CANDIDATE;
    expect(cannotAffordRemainingRequests(required - 1, 3, ESTIMATED_REQUESTS_PER_CANDIDATE)).toBe(
      true,
    );
    expect(cannotAffordRemainingRequests(required, 3, ESTIMATED_REQUESTS_PER_CANDIDATE)).toBe(
      false,
    );
  });

  it("1 件あたりの想定リクエスト数を 1 にすると、ファイル単位（1 件 = 1 リクエスト）の見積もりになる", () => {
    // 残り 2 件（自分自身を含め 3 件分）の必要見積もりは 3 * 1 = 3
    expect(cannotAffordRemainingRequests(2, 2, 1)).toBe(true);
    expect(cannotAffordRemainingRequests(3, 2, 1)).toBe(false);
  });
});

describe("mergeObservedRateLimit", () => {
  it("まだ観測していなければ新しい観測値をそのまま採用する", () => {
    const next = { remaining: 100, resetAt: undefined };
    expect(mergeObservedRateLimit(undefined, next)).toBe(next);
  });

  it("同じウィンドウ内で残量が既存より小さければ採用する（単調減少）", () => {
    const resetAt = new Date("2026-01-01T00:00:00Z");
    const current = { remaining: 50, resetAt };
    const next = { remaining: 30, resetAt };
    expect(mergeObservedRateLimit(current, next)).toEqual(next);
  });

  it("同じウィンドウ内で残量が既存より大きければ既存を保持する（後発の完了順の逆転に強い）", () => {
    const resetAt = new Date("2026-01-01T00:00:00Z");
    const current = { remaining: 30, resetAt };
    const next = { remaining: 50, resetAt };
    expect(mergeObservedRateLimit(current, next)).toBe(current);
  });

  it("ウィンドウが変わっていれば、残量の大小によらず新しい観測値を採用する", () => {
    const current = { remaining: 10, resetAt: new Date("2026-01-01T00:00:00Z") };
    const next = { remaining: 5000, resetAt: new Date("2026-01-01T01:00:00Z") };
    expect(mergeObservedRateLimit(current, next)).toBe(next);
  });

  it("resetAt が片方だけ undefined なら、ウィンドウが変わったとみなして新しい観測値を採用する", () => {
    const current = { remaining: 10, resetAt: new Date("2026-01-01T00:00:00Z") };
    const next = { remaining: 5000, resetAt: undefined };
    expect(mergeObservedRateLimit(current, next)).toBe(next);
  });

  it("両方の resetAt が undefined なら、同じウィンドウとして単調減少の判定を適用する", () => {
    const current = { remaining: 10, resetAt: undefined };
    const largerNext = { remaining: 20, resetAt: undefined };
    expect(mergeObservedRateLimit(current, largerNext)).toBe(current);

    const smallerNext = { remaining: 5, resetAt: undefined };
    expect(mergeObservedRateLimit(current, smallerNext)).toBe(smallerNext);
  });
});

describe("rateLimitSkipReason", () => {
  it("observed（実際に 403/429 を受け取った）とpreemptive（先読みで自発的に止めた）で文言が異なる", () => {
    const observed = rateLimitSkipReason({ _tag: "observed", resetAt: undefined });
    const preemptive = rateLimitSkipReason({ _tag: "preemptive", resetAt: undefined });

    expect(observed).toContain("GitHub API rate limit reached");
    expect(preemptive).toContain("Stopped short of the GitHub API rate limit");
    expect(observed).not.toBe(preemptive);
  });

  it("resetAt が無ければリセット時刻を案内文に含めない", () => {
    const reason = rateLimitSkipReason({ _tag: "observed", resetAt: undefined });
    expect(reason).toBe(
      "GitHub API rate limit reached; not checking further repositories in this scan.",
    );
  });

  it("resetAt があれば、リセットまでの残り時間を分単位で案内文に含める", () => {
    const resetAt = new Date(Date.now() + 5 * 60_000);
    const reason = rateLimitSkipReason({ _tag: "observed", resetAt });
    expect(reason).toMatch(/resets in ~5 min/);
  });
});
