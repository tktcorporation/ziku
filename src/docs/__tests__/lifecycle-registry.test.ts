/**
 * ライフサイクル登録表とラベル表の網羅性ガードテスト。
 *
 * ドキュメント生成はこの 2 つの表だけを見るので、登録が欠けたコマンドはドキュメントから
 * 黙って消え、ラベルが無い操作は生の識別子のまま出る。どちらも型で必須にしてあり、
 * ここでは「その必須が実際に効いていること」を固定する。
 */

import { describe, expect, it } from "vitest";
import { SUBCOMMAND_NAMES } from "../../commands/names";
import { LIFECYCLE_BY_COMMAND, OP_LABELS, lifecycle } from "../lifecycle";

describe("LIFECYCLE_BY_COMMAND", () => {
  it("すべてのサブコマンドのライフサイクルを持つ", () => {
    expect(Object.keys(LIFECYCLE_BY_COMMAND).toSorted()).toEqual([...SUBCOMMAND_NAMES].toSorted());
  });

  it("lifecycle は登録表の値を宣言順で引き継ぐ", () => {
    // ドキュメントの節の並びは登録表の宣言順で決まる。
    expect(lifecycle).toEqual(Object.values(LIFECYCLE_BY_COMMAND));
  });

  it("型: コマンドを足したらライフサイクルの登録が必須になる", () => {
    // 登録の強制が型の役目なので、@ts-expect-error が外れたら（= 空の表が書けるように
    // なったら）typecheck が失敗して気付ける。
    // @ts-expect-error コマンドごとのライフサイクルを欠いた表は登録表の型を満たさない
    const missing: typeof LIFECYCLE_BY_COMMAND = {};
    expect(Object.keys(missing)).toEqual([]);
  });
});

describe("OP_LABELS", () => {
  it("登録された操作すべてに識別子と異なる表示ラベルがある", () => {
    for (const [op, label] of Object.entries(OP_LABELS)) {
      expect(label).not.toBe(op);
      expect(label).not.toBe("");
    }
  });

  it("型: 操作の種類を足したらラベルの登録が必須になる", () => {
    // @ts-expect-error 操作ごとのラベルを欠いた表は OP_LABELS の型を満たさない
    const missing: typeof OP_LABELS = {};
    expect(Object.keys(missing)).toEqual([]);
  });
});
