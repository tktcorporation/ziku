import { describe, expect, it } from "vitest";
import { hashMap, repoRelPath } from "../../__tests__/brands";
import {
  asBaseContent,
  asLocalContent,
  asTemplateContent,
  classifyFiles,
  findConflictRegions,
  threeWayMerge,
} from "../merge";

/** テスト用ヘルパー: named params で threeWayMerge を呼ぶ */
function merge(base: string, local: string, template: string, filePath?: string) {
  return threeWayMerge({
    base: asBaseContent(base),
    local: asLocalContent(local),
    template: asTemplateContent(template),
    filePath: filePath === undefined ? undefined : repoRelPath(filePath),
  });
}

describe("merge", () => {
  describe("classifyFiles", () => {
    it("全カテゴリに正しく分類する", () => {
      const result = classifyFiles({
        baseHashes: hashMap({
          "unchanged.txt": "aaa",
          "auto-update.txt": "bbb",
          "local-only.txt": "ccc",
          "conflict.txt": "ddd",
          "deleted.txt": "eee",
          "deleted-locally.txt": "fff",
          "deleted-with-edits.txt": "ggg",
        }),
        localHashes: hashMap({
          "unchanged.txt": "aaa",
          "auto-update.txt": "bbb",
          "local-only.txt": "ccc-modified",
          "conflict.txt": "ddd-local",
          "deleted-with-edits.txt": "ggg-edited",
        }),
        templateHashes: hashMap({
          "unchanged.txt": "aaa",
          "auto-update.txt": "bbb-updated",
          "local-only.txt": "ccc",
          "conflict.txt": "ddd-template",
          "new-file.txt": "fff",
          "deleted-locally.txt": "fff", // base と同じ → クリーン削除
        }),
      });

      expect(result.unchanged).toContain("unchanged.txt");
      expect(result.autoUpdate).toContain("auto-update.txt");
      expect(result.localOnly).toContain("local-only.txt");
      expect(result.conflicts).toContain("conflict.txt");
      expect(result.newFiles).toContain("new-file.txt");
      expect(result.deletedFiles).toContain("deleted.txt");
      expect(result.deletedLocally).toContain("deleted-locally.txt");
      expect(result.deletedWithLocalEdits).toContain("deleted-with-edits.txt");
    });

    // conflicts の要素はテンプレート内容をマージの片側として読むため、テンプレート側に
    // 存在しないファイルが混ざると mergeOneFile が defect でクラッシュする。
    it("conflicts に入るファイルはすべてテンプレート側に存在する（mergeOneFile の不変条件）", () => {
      const result = classifyFiles({
        baseHashes: hashMap({
          "both-changed.txt": "aaa",
          "local-deleted.txt": "bbb",
          "template-deleted.txt": "ccc",
          "template-deleted-clean.txt": "ddd",
          "gone-everywhere.txt": "eee",
        }),
        localHashes: hashMap({
          "both-changed.txt": "aaa-local",
          "template-deleted.txt": "ccc-edited",
          "template-deleted-clean.txt": "ddd",
          "local-new.txt": "fff",
        }),
        templateHashes: hashMap({
          "both-changed.txt": "aaa-template",
          "local-deleted.txt": "bbb-updated",
          "template-new.txt": "ggg",
        }),
      });

      const templatePaths = new Set(["both-changed.txt", "local-deleted.txt", "template-new.txt"]);
      expect(result.conflicts.length).toBeGreaterThan(0);
      for (const file of result.conflicts) {
        expect(templatePaths.has(file)).toBe(true);
      }
    });

    it("空のハッシュマップを処理する", () => {
      const result = classifyFiles({
        baseHashes: {},
        localHashes: {},
        templateHashes: {},
      });

      expect(result.unchanged).toEqual([]);
      expect(result.autoUpdate).toEqual([]);
      expect(result.localOnly).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.newFiles).toEqual([]);
      expect(result.deletedFiles).toEqual([]);
      expect(result.deletedWithLocalEdits).toEqual([]);
      expect(result.deletedLocally).toEqual([]);
    });

    it("ローカルのみに存在するファイルを localOnly に分類する", () => {
      const result = classifyFiles({
        baseHashes: {},
        localHashes: hashMap({ "my-file.txt": "abc" }),
        templateHashes: {},
      });

      expect(result.localOnly).toContain("my-file.txt");
    });

    it("ローカルで削除されたファイルを deletedLocally に分類する", () => {
      const result = classifyFiles({
        baseHashes: hashMap({ "removed.txt": "abc" }),
        localHashes: {},
        templateHashes: hashMap({ "removed.txt": "abc" }),
      });

      expect(result.deletedLocally).toContain("removed.txt");
      // 他のカテゴリに入っていないことを確認
      expect(result.localOnly).not.toContain("removed.txt");
      expect(result.conflicts).not.toContain("removed.txt");
      expect(result.deletedFiles).not.toContain("removed.txt");
    });

    it("テンプレートも更新されローカルで削除 → delete/modify conflict（git 準拠）", () => {
      const result = classifyFiles({
        baseHashes: hashMap({ "removed.txt": "abc" }),
        localHashes: {},
        templateHashes: hashMap({ "removed.txt": "def" }),
      });

      // テンプレートが変更されている場合は conflict（delete/modify）
      expect(result.conflicts).toContain("removed.txt");
      expect(result.deletedLocally).not.toContain("removed.txt");
    });

    it("テンプレートで削除されローカルが編集済み → deletedWithLocalEdits", () => {
      const result = classifyFiles({
        baseHashes: hashMap({ "rules.md": "abc" }),
        localHashes: hashMap({ "rules.md": "abc-edited" }),
        templateHashes: {},
      });

      // 「削除するか編集を残すか」の二択であって、テキストマージの対象ではない。
      // テンプレート側にファイルが無いので conflicts にも入れられない。
      expect(result.deletedWithLocalEdits).toContain("rules.md");
      expect(result.conflicts).not.toContain("rules.md");
      expect(result.deletedFiles).not.toContain("rules.md");
    });

    it("テンプレートで削除されローカルが base のまま → deletedFiles", () => {
      const result = classifyFiles({
        baseHashes: hashMap({ "rules.md": "abc" }),
        localHashes: hashMap({ "rules.md": "abc" }),
        templateHashes: {},
      });

      expect(result.deletedFiles).toContain("rules.md");
      expect(result.deletedWithLocalEdits).not.toContain("rules.md");
      expect(result.conflicts).not.toContain("rules.md");
    });

    it("base とテンプレート両方で削除されたファイルは deletedFiles に分類する（deletedLocally ではない）", () => {
      const result = classifyFiles({
        baseHashes: hashMap({ "removed.txt": "abc" }),
        localHashes: {},
        templateHashes: {},
      });

      expect(result.deletedFiles).toContain("removed.txt");
      expect(result.deletedLocally).not.toContain("removed.txt");
    });

    it("両方が同じ内容に変更された場合は unchanged に分類する", () => {
      const result = classifyFiles({
        baseHashes: hashMap({ "file.txt": "old" }),
        localHashes: hashMap({ "file.txt": "new" }),
        templateHashes: hashMap({ "file.txt": "new" }),
      });

      expect(result.unchanged).toContain("file.txt");
    });
  });

  describe("threeWayMerge", () => {
    it("クリーンマージ: 異なる箇所への変更が正しくマージされる", () => {
      const base = "line1\nline2\nline3\n";
      const local = "local-added\nline1\nline2\nline3\n";
      const template = "line1\nline2\nline3\ntemplate-added\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toContain("local-added");
      expect(result.content).toContain("template-added");
    });

    it("コンフリクト: 同じ行を異なる内容に変更した場合", () => {
      const base = "line1\noriginal\nline3\n";
      const local = "line1\nlocal-change\nline3\n";
      const template = "line1\ntemplate-change\nline3\n";

      const result = merge(base, local, template);

      // diff3Merge が同じ行の異なる変更を検出してコンフリクトマーカーを挿入する
      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("=======");
      expect(result.content).toContain(">>>>>>> TEMPLATE");
    });

    it("ローカルとテンプレートが同一の場合はコンフリクトなし", () => {
      const base = "original content\n";
      const local = "same modified content\n";
      const template = "same modified content\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("same modified content\n");
    });

    it("ローカルが base と同一の場合はテンプレートの内容になる", () => {
      const base = "original\n";
      const local = "original\n";
      const template = "updated by template\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("updated by template\n");
    });

    it("テンプレートが base と同一の場合はローカルの内容を保持する", () => {
      const base = "original\n";
      const local = "modified locally\n";
      const template = "original\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("modified locally\n");
    });

    it("delete/modify conflict: ローカルが空文字列（削除）でテンプレートが変更 → conflict", () => {
      const base = "original content\nline 2\n";
      const local = ""; // ローカルで全削除
      const template = "original content\nline 2 modified\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Conflicted");
    });

    it("JSON ファイルでも行レベルの 3-way マージが適用される", () => {
      const base = '{\n  "a": 1,\n  "b": 2\n}\n';
      const local = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
      const template = '{\n  "a": 1,\n  "b": 2,\n  "d": 4\n}\n';

      const result = merge(base, local, template, "config.json");

      // 両側が同じ末尾行（"b": 2）を書き換えて別のキーを足しているため、
      // 行レベルでは同じ領域の変更として conflict になる
      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain('"c": 3');
      expect(result.content).toContain('"d": 4');
    });

    it("filePath なしの場合はテキストマージを使用する", () => {
      const base = "line1\nline2\nline3\n";
      const local = "line1\nline2-modified\nline3\n";
      const template = "line1\nline2\nline3\nline4\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
    });
  });

  describe("threeWayMerge - テキストマージ改善", () => {
    it("fuzz factor でパッチ適用精度が上がる", () => {
      // ローカルで微小な変更があっても、離れた位置のテンプレート変更が適用される
      const base = "header\nline1\nline2\nline3\nline4\nline5\nfooter\n";
      const local = "header-modified\nline1\nline2\nline3\nline4\nline5\nfooter\n";
      const template = "header\nline1\nline2\nline3\nline4\nline5\nfooter-updated\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toContain("header-modified");
      expect(result.content).toContain("footer-updated");
    });

    it("hunk 単位のコンフリクトマーカーで影響範囲を最小化", () => {
      // 十分に離れた2箇所を変更して、別々の hunk になるようにする
      const baseLines = [
        "line1",
        "original-a",
        "line3",
        "line4",
        "line5",
        "line6",
        "line7",
        "line8",
        "line9",
        "line10",
        "original-b",
        "line12",
        "",
      ];
      const localLines = [...baseLines];
      localLines[1] = "local-a";
      localLines[10] = "local-b";
      const templateLines = [...baseLines];
      templateLines[1] = "template-a";
      templateLines[10] = "template-b";

      const base = baseLines.join("\n");
      const local = localLines.join("\n");
      const template = templateLines.join("\n");

      const result = merge(base, local, template);

      if (result._tag === "Conflicted") {
        // マーカーが含まれるが、変更されていない行（line3〜line9）も結果に含まれる
        expect(result.content).toContain("<<<<<<< LOCAL");
        expect(result.content).toContain(">>>>>>> TEMPLATE");
        // 変更がないコンテキスト行がそのまま残っている
        expect(result.content).toContain("line5");
        expect(result.content).toContain("line6");
      }
    });
  });

  describe("threeWayMerge - local/template の非対称性（回帰テスト）", () => {
    it("コンフリクト時にコンフリクトマーカーを挿入する", () => {
      // 背景: 引数が逆転してテンプレート側がベースになると、ローカルのコメントが消える
      // テキストマージではコメントは通常の行として扱われるため、コンフリクト時はマーカーで保護される
      const base = '{\n  "version": "1.0"\n}';
      const local = '{\n  "version": "2.0-user"\n}';
      const template = '{\n  "version": "2.0-template"\n}';

      const result = merge(base, local, template, "package.json");

      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("=======");
      expect(result.content).toContain(">>>>>>> TEMPLATE");
      expect(result.content).toContain("2.0-user");
      expect(result.content).toContain("2.0-template");
    });

    it("引数を逆にすると結果が変わることを検証（非対称性の証明）", () => {
      // local と template を入れ替えると、コンフリクトマーカー内の表示が変わる
      const base = '{\n  "key": "original"\n}';
      const localValue = '{\n  "key": "local-change"\n}';
      const templateValue = '{\n  "key": "template-change"\n}';

      // 正しい順序
      const correct = merge(base, localValue, templateValue, "test.json");
      // 逆の順序
      const reversed = merge(base, templateValue, localValue, "test.json");

      expect(correct._tag).toBe("Conflicted");
      expect(reversed._tag).toBe("Conflicted");

      // どちらもコンフリクトマーカーが含まれる
      expect(correct.content).toContain("<<<<<<< LOCAL");
      expect(reversed.content).toContain("<<<<<<< LOCAL");
    });
  });

  describe("threeWayMerge - TOML ファイル", () => {
    it("TOML ファイルの異なる箇所の変更がクリーンマージされる", () => {
      const base = '[tools]\nnode = "20"\n\n[settings]\nexperimental = true\n';
      const local = '[tools]\nnode = "20"\npython = "3.12"\n\n[settings]\nexperimental = true\n';
      const template = '[tools]\nnode = "20"\n\n[settings]\nexperimental = true\nquiet = true\n';

      const result = merge(base, local, template, "config.toml");

      expect(result._tag).toBe("Clean");
      expect(result.content).toContain('python = "3.12"');
      expect(result.content).toContain("quiet = true");
    });
  });

  describe("threeWayMerge - YAML ファイル", () => {
    it("YAML ファイルの異なる箇所の変更がクリーンマージされる", () => {
      const base = "name: test\nversion: 1\n\nsection2:\n  key: value\n";
      const local = "name: test\nversion: 1\nauthor: me\n\nsection2:\n  key: value\n";
      const template = "name: test\nversion: 1\n\nsection2:\n  key: updated\n";

      const result = merge(base, local, template, "config.yml");

      expect(result._tag).toBe("Clean");
      expect(result.content).toContain("author: me");
      expect(result.content).toContain("key: updated");
    });
  });

  describe("threeWayMerge - テキストマージ後のバリデーション", () => {
    // 行レベルではクリーンにマージできるが、結果が JSON として壊れる組み合わせ。
    // ローカルが閉じ括弧を失っており、テンプレートは離れた行だけを変更している。
    const brokenJson = {
      base: '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n',
      local: '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n',
      template: '{\n  "a": 10,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n',
    };

    it("テキストマージ自体は行レベルでクリーンに通る（バリデーションの前提）", () => {
      const result = merge(brokenJson.base, brokenJson.local, brokenJson.template);

      expect(result._tag).toBe("Clean");
      expect(result.content).not.toContain("<<<<<<<");
    });

    it("テキストマージが壊れた構造ファイルを生成した場合、コンフリクトマーカーにフォールバック", () => {
      const result = merge(brokenJson.base, brokenJson.local, brokenJson.template, "config.json");

      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("||||||| BASE");
      expect(result.content).toContain(">>>>>>> TEMPLATE");
      // 両側の内容がそのまま残っている（どちらかが欠けたら解決できない）
      expect(result.content).toContain('"a": 1,');
      expect(result.content).toContain('"a": 10,');
    });

    it("ファイル全体フォールバックが末尾改行を保ち、マーカー直前に空行を入れない", () => {
      const result = merge(brokenJson.base, brokenJson.local, brokenJson.template, "config.json");

      expect(result.content.endsWith(">>>>>>> TEMPLATE\n")).toBe(true);
      expect(result.content).not.toContain("\n\n|||||||");
      expect(result.content).not.toContain("\n\n=======");
      expect(result.content).not.toContain("\n\n>>>>>>>");
    });

    it("構造が壊れていない JSON はクリーンマージのまま確定する", () => {
      const base = '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n';
      const local = '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 50\n}\n';
      const template = '{\n  "a": 10,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n';

      const result = merge(base, local, template, "config.json");

      expect(result._tag).toBe("Clean");
      expect(JSON.parse(result.content)).toEqual({ a: 10, b: 2, c: 3, d: 4, e: 50 });
    });
  });

  describe("threeWayMerge - コンフリクトマーカーの生成", () => {
    it("base セクションを出力する（git の diff3 conflict style 相当）", () => {
      const base = "line1\noriginal\nline3\n";
      const local = "line1\nlocal-change\nline3\n";
      const template = "line1\ntemplate-change\nline3\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Conflicted");
      const markerOrder = result.content
        .split("\n")
        .filter((line) => /^[<|=>]{7}/.test(line))
        .map((line) => line.slice(0, 7));
      expect(markerOrder).toEqual(["<<<<<<<", "|||||||", "=======", ">>>>>>>"]);
      // base セクションに共通祖先の行が入る
      expect(result.content).toContain("||||||| BASE\noriginal\n=======");
    });

    it("既にマーカーを含む内容をマージするとマーカーが伸長される", () => {
      const withMarkers = [
        "intro",
        "<<<<<<< LOCAL",
        "unresolved local",
        "=======",
        "unresolved template",
        ">>>>>>> TEMPLATE",
        "outro",
        "",
      ].join("\n");
      const base = withMarkers;
      const local = withMarkers.replace("intro", "intro-local");
      const template = withMarkers.replace("intro", "intro-template");

      const result = merge(base, local, template);

      expect(result._tag).toBe("Conflicted");
      // 生成されたマーカーは 3 種とも 8 文字。既存の 7 文字マーカーは内容として残る
      expect(result.content).toContain("<<<<<<<< LOCAL");
      expect(result.content).toContain("|||||||| BASE");
      expect(result.content).toContain("\n========\n");
      expect(result.content).toContain(">>>>>>>> TEMPLATE");
      expect(result.content).toContain("<<<<<<< LOCAL");
    });
  });

  describe("threeWayMerge - 改行コードと BOM", () => {
    it("CRLF のファイルはマージ後も CRLF のまま", () => {
      const base = "line1\r\noriginal\r\nline3\r\n";
      const local = "line1\r\nlocal-change\r\nline3\r\n";
      const template = "line1\r\noriginal\r\nline3\r\ntemplate-added\r\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("line1\r\nlocal-change\r\nline3\r\ntemplate-added\r\n");
      expect(result.content).not.toMatch(/[^\r]\n/);
    });

    it("改行コードだけが違う両側は差分にならず、内容の変更だけがマージされる", () => {
      const base = "line1\r\nline2\r\n";
      const local = "line1\r\nline2\r\n";
      const template = "line1\nline2\ntemplate-added\n";

      const result = merge(base, local, template);

      // 全行が衝突するのではなく、テンプレートが加えた 1 行だけが反映される
      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("line1\r\nline2\r\ntemplate-added\r\n");
    });

    it("両側の内容が同一で改行コードだけ違う場合はローカルの改行コードを保つ", () => {
      const result = merge("line1\n", "line1\r\n", "line1\n");

      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("line1\r\n");
    });

    it("生成するコンフリクトマーカーもファイルの改行コードに合わせる", () => {
      const base = "line1\r\noriginal\r\n";
      const local = "line1\r\nlocal-change\r\n";
      const template = "line1\r\ntemplate-change\r\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL\r\n");
      expect(result.content).toContain(">>>>>>> TEMPLATE\r\n");
      expect(result.content).not.toMatch(/[^\r]\n/);
    });

    it("BOM 付きのファイルはマージ後も BOM を保つ", () => {
      const base = "\uFEFFline1\nline2\nline3\n";
      const local = "\uFEFFline1\nlocal-change\nline3\n";
      const template = "line1\nline2\nline3\ntemplate-added\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content.startsWith("\uFEFF")).toBe(true);
      // BOM は 1 つだけで、内容の途中には現れない
      expect(result.content.slice(1)).not.toContain("\uFEFF");
      expect(result.content).toContain("local-change");
      expect(result.content).toContain("template-added");
    });

    it("BOM の有無だけが違う両側は差分にならない", () => {
      const result = merge("line1\n", "\uFEFFline1\n", "line1\nadded\n");

      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("\uFEFFline1\nadded\n");
    });

    it("ローカルが削除されている場合はテンプレートの改行コードを保つ", () => {
      const base = "line1\r\nline2\r\n";
      const template = "line1\r\nline2\r\ntemplate-added\r\n";

      const result = merge(base, "", template);

      expect(result.content).toContain("\r\n");
      expect(result.content).not.toMatch(/[^\r]\n/);
    });

    it("ローカルが削除されている場合はテンプレートの BOM を保つ", () => {
      const result = merge("\uFEFFline1\n", "", "\uFEFFline1\ntemplate-added\n");

      expect(result.content.startsWith("\uFEFF")).toBe(true);
      expect(result.content.slice(1)).not.toContain("\uFEFF");
    });

    it("ローカルもテンプレートも空なら結果も空", () => {
      const result = merge("line1\r\n", "", "");

      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("");
    });

    it("BOM 付きファイルの 1 行目から始まるコンフリクトも未解決として検出される", () => {
      const base = "\uFEFForiginal\ntail\n";
      const local = "\uFEFFlocal-change\ntail\n";
      const template = "\uFEFFtemplate-change\ntail\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Conflicted");
      if (result._tag !== "Conflicted") return;
      expect(result.regions[0].startLine).toBe(1);
      // BOM はファイル先頭に戻り、マーカーの内側には入らない
      expect(result.content.startsWith("\uFEFF<<<<<<< LOCAL")).toBe(true);
    });
  });

  describe("MergeOutcome", () => {
    it("コンフリクトしたマージは Conflicted になり、regions が実際のマーカー位置を指す", () => {
      const base = "line1\nline2\nline3\n";
      const local = "line1\nlocal-change\nline3\n";
      const template = "line1\ntemplate-change\nline3\n";

      const result = merge(base, local, template);

      if (result._tag !== "Conflicted") throw new Error(`expected Conflicted, got ${result._tag}`);
      const startLines = result.regions.map((r) => r.startLine);
      expect(startLines.length).toBeGreaterThan(0);
      // 各 startLine が実際に開始マーカーの行を指している
      const lines = result.content.split("\n");
      for (const startLine of startLines) {
        expect(lines[startLine - 1]).toMatch(/^<{7,} /);
      }
    });

    it("両側が離れた行を変更したマージは Clean になる", () => {
      const base = "line1\nline2\nline3\nline4\nline5\n";
      const local = "line1-local\nline2\nline3\nline4\nline5\n";
      const template = "line1\nline2\nline3\nline4\nline5-template\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toContain("line1-local");
      expect(result.content).toContain("line5-template");
    });

    it("ローカルとテンプレートが同一でも、未解決マーカーが残っていれば Conflicted", () => {
      // 内容が一致していてもマーカー入りのテキストは解決済みではない。Clean として
      // 素通しすると、そのままテンプレートへの PR に載る。
      const unresolved = ["<<<<<<< LOCAL", "a", "=======", "b", ">>>>>>> TEMPLATE", ""].join("\n");

      const result = merge("base\n", unresolved, unresolved);

      expect(result._tag).toBe("Conflicted");
    });
  });

  describe("findConflictRegions", () => {
    it("コンフリクトマーカーを含む内容を検出し、ブロックの開始行を返す", () => {
      const content = `line1
<<<<<<< LOCAL
local content
=======
template content
>>>>>>> TEMPLATE
line2`;

      const regions = findConflictRegions(content);

      expect(regions).toEqual([{ startLine: 2 }]);
    });

    it("base セクション付き（diff3 形式）のブロックを検出する", () => {
      const content = [
        "<<<<<<< LOCAL",
        "local content",
        "||||||| BASE",
        "base content",
        "=======",
        "template content",
        ">>>>>>> TEMPLATE",
        "",
      ].join("\n");

      const regions = findConflictRegions(content);

      expect(regions).toEqual([{ startLine: 1 }]);
    });

    it("伸長されたマーカーのブロックを検出する", () => {
      const content = [
        "<<<<<<<< LOCAL",
        "local content",
        "|||||||| BASE",
        "base content",
        "========",
        "template content",
        ">>>>>>>> TEMPLATE",
        "",
      ].join("\n");

      const regions = findConflictRegions(content);

      expect(regions).toEqual([{ startLine: 1 }]);
    });

    it("複数ブロックをすべて検出する", () => {
      const content = [
        "<<<<<<< LOCAL",
        "a",
        "=======",
        "b",
        ">>>>>>> TEMPLATE",
        "middle",
        "<<<<<<< LOCAL",
        "c",
        "=======",
        "d",
        ">>>>>>> TEMPLATE",
        "",
      ].join("\n");

      const regions = findConflictRegions(content);

      expect(regions.map((r) => r.startLine)).toEqual([1, 7]);
    });

    it("コンフリクトマーカーがない場合", () => {
      const content = "normal line1\nnormal line2\nnormal line3\n";

      const regions = findConflictRegions(content);

      expect(regions).toEqual([]);
    });

    it("Markdown の setext 見出しと区切り線を未解決と誤検出しない", () => {
      const content = [
        "Document Title",
        "==============",
        "",
        "本文",
        "",
        "Section",
        "=======",
        "",
        "本文",
        "",
      ].join("\n");

      const regions = findConflictRegions(content);

      expect(regions).toEqual([]);
    });

    it("対応する `=======` / `>>>>>>>` が無い `<<<<<<<` は未解決とみなさない", () => {
      // 誤検出すると `pull --continue` が永久に通らず、lock を手編集する以外に
      // 復旧手段が無くなる。対応の取れたブロックだけを未解決として扱う。
      const content = "line1\n<<<<<<< LOCAL\nsome content\n";

      const regions = findConflictRegions(content);

      expect(regions).toEqual([]);
    });

    it("閉じ側のマーカーだけを消したブロックは未解決のまま", () => {
      // 数えないと `pull --continue` が通り、開始マーカーと区切り行が残ったまま
      // 同期ベースへ載って、以後テンプレートへ送られる。
      const content = ["<<<<<<< LOCAL", "a", "=======", "b", ""].join("\n");

      const regions = findConflictRegions(content);

      expect(regions.map((r) => r.startLine)).toEqual([1]);
    });

    it("`|||||||` まで進んで閉じないブロックも未解決のまま", () => {
      const content = ["<<<<<<< LOCAL", "a", "||||||| BASE", "o", ""].join("\n");

      const regions = findConflictRegions(content);

      expect(regions.map((r) => r.startLine)).toEqual([1]);
    });

    it("閉じたブロックの後ろに開きかけのブロックが残る場合は両方数える", () => {
      const content = [
        "<<<<<<< LOCAL",
        "a",
        "=======",
        "b",
        ">>>>>>> TEMPLATE",
        "<<<<<<< LOCAL",
        "c",
        "=======",
        "d",
        "",
      ].join("\n");

      const regions = findConflictRegions(content);

      expect(regions.map((r) => r.startLine)).toEqual([1, 6]);
    });

    it("マージ結果に残るブロックだけを数え、内容中の短いマーカーは本文として扱う", () => {
      const withMarkers = ["intro", "<<<<<<< LOCAL", "a", "=======", "b", ">>>>>>> TEMPLATE", ""];
      const base = withMarkers.join("\n");
      const local = base.replace("intro", "intro-local");
      const template = base.replace("intro", "intro-template");

      const merged = merge(base, local, template);
      const regions = findConflictRegions(merged.content);

      // 生成された 8 文字ブロック（1 行目）と、未解決のまま残る 7 文字ブロックの両方
      expect(regions.map((r) => r.startLine)).toEqual([1, 8]);
    });
  });

  // ====================================================================
  // 契約検証: threeWayMerge の結果が正しいことを保証するテスト
  // ====================================================================
  //
  // 契約: threeWayMerge が Clean を返す場合、
  // result.content にはテンプレート側の変更が反映されていなければならない。
  // ローカル側の変更も保持されていなければならない。
  // どちらかが消失している場合はバグ。

  describe("契約検証: Clean ならテンプレート変更が反映されている", () => {
    it("JSON: 両方が同じ末尾行へ別のキーを追加 → 両側の変更がマーカー内に残る", () => {
      const base = JSON.stringify({ a: 1 }, null, 2);
      const local = JSON.stringify({ a: 1, localKey: "local" }, null, 2);
      const template = JSON.stringify({ a: 1, templateKey: "template" }, null, 2);

      const result = merge(base, local, template, "settings.json");

      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("localKey");
      expect(result.content).toContain("templateKey");
    });

    it("JSON: 同じキーを異なる値に変更 → 必ずコンフリクトになる", () => {
      const base = JSON.stringify({ version: "1.0" }, null, 2);
      const local = JSON.stringify({ version: "2.0-local" }, null, 2);
      const template = JSON.stringify({ version: "2.0-template" }, null, 2);

      const result = merge(base, local, template, "package.json");

      // 同じキーを異なる値に変更 → 必ずコンフリクトであるべき
      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("2.0-local");
      expect(result.content).toContain("2.0-template");
    });

    it("JSON: 配列を異なるように変更 → 必ずコンフリクトになる", () => {
      const base = JSON.stringify({ permissions: { allow: ["Bash(npm run *)"] } }, null, 2);
      const local = JSON.stringify(
        { permissions: { allow: ["Bash(npm run *)", "Bash(pnpm *)"] } },
        null,
        2,
      );
      const template = JSON.stringify(
        { permissions: { allow: ["Bash(npm run *)", "Bash(git *)"] } },
        null,
        2,
      );

      const result = merge(base, local, template, ".claude/settings.json");

      // 配列の同じ位置を異なる内容に変更 → コンフリクト
      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("pnpm");
      expect(result.content).toContain("git");
    });

    it("JSON: コンフリクトあるキーとないキーの混合", () => {
      const base = JSON.stringify(
        { conflict: "base", noConflict: "base", shared: "same" },
        null,
        2,
      );
      const local = JSON.stringify(
        { conflict: "local", noConflict: "base", shared: "same", localOnly: true },
        null,
        2,
      );
      const template = JSON.stringify(
        { conflict: "template", noConflict: "updated", shared: "same" },
        null,
        2,
      );

      const result = merge(base, local, template, "config.json");

      // 変更が隣接する行に集中しているため 1 つのブロックにまとまり、
      // 両側の変更がマーカー内に可視化される
      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain('"updated"');
      expect(result.content).toContain("localOnly");
    });

    it("Markdown: 同じ行を異なる内容に変更 → コンフリクトマーカーが挿入される", () => {
      const base = "# Title\n\nOriginal content here.\n\n## Section 2\nMore content\n";
      const local = "# Title\n\nLocal modified content.\n\n## Section 2\nMore content\n";
      const template = "# Title\n\nTemplate modified content.\n\n## Section 2\nMore content\n";

      const result = merge(base, local, template, "rules/pr-workflow.md");

      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("Local modified");
      expect(result.content).toContain("Template modified");
    });

    it("Markdown: 異なるセクションを変更 → クリーンマージで両方反映", () => {
      const base =
        "# Title\n\nSection 1 content\n\n## Section 2\n\nSection 2 content\n\n## Section 3\n\nSection 3 content\n";
      const local =
        "# Title\n\nLocal change in section 1\n\n## Section 2\n\nSection 2 content\n\n## Section 3\n\nSection 3 content\n";
      const template =
        "# Title\n\nSection 1 content\n\n## Section 2\n\nSection 2 content\n\n## Section 3\n\nTemplate change in section 3\n";

      const result = merge(base, local, template, "rules/pr-workflow.md");

      if (result._tag === "Clean") {
        expect(result.content).toContain("Local change in section 1");
        expect(result.content).toContain("Template change in section 3");
      }
    });
  });

  describe("テキストマージの fuzz 検証", () => {
    it("同じ行の変更は fuzz で上書きされない", () => {
      const base = '{\n  "version": "1.0"\n}\n';
      const local = '{\n  "version": "2.0-local"\n}\n';
      const template = '{\n  "version": "2.0-template"\n}\n';

      const result = merge(base, local, template);

      if (result._tag === "Clean") {
        expect(result.content).toContain("2.0-local");
      }
    });

    it("隣接する行の異なる変更は両方保持されるかマーカーが入る", () => {
      const base = "line1\nline2\nline3\nline4\nline5\n";
      const local = "line1\nLOCAL\nline3\nline4\nline5\n";
      const template = "line1\nline2\nline3\nTEMPLATE\nline5\n";

      const result = merge(base, local, template);

      if (result._tag === "Conflicted") {
        expect(result.content).toContain("<<<<<<< LOCAL");
      } else {
        expect(result.content).toContain("LOCAL");
        expect(result.content).toContain("TEMPLATE");
      }
    });
  });

  describe("根本原因: コンフリクトが fuzz で自動解決されてしまう問題", () => {
    it("JSON: 配列の conflict が fuzz で自動解決されてはならない", () => {
      const base = JSON.stringify(
        {
          permissions: { allow: ["tool-a"], deny: [] },
          image: "node:20",
          extra: { key1: "v1", key2: "v2", key3: "v3", key4: "v4" },
        },
        null,
        2,
      );
      const local = JSON.stringify(
        {
          permissions: { allow: ["tool-a", "tool-b"], deny: [] },
          image: "node:20",
          extra: { key1: "v1", key2: "v2", key3: "v3", key4: "v4" },
          localConfig: true,
        },
        null,
        2,
      );
      const template = JSON.stringify(
        {
          permissions: { allow: ["tool-a", "tool-c"], deny: [] },
          image: "node:22",
          extra: { key1: "v1", key2: "v2", key3: "v3", key4: "v4" },
        },
        null,
        2,
      );

      const result = merge(base, local, template, "settings.json");

      // permissions.allow 配列を両側が異なる内容に変更 → コンフリクトであるべき
      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
    });

    it("TOML: 同じキーを異なる値に変更 → コンフリクトマーカー必須", () => {
      const base = '[tools]\nnode = "20"\n\n[settings]\nexperimental = true\n';
      const local = '[tools]\nnode = "22"\npython = "3.12"\n\n[settings]\nexperimental = true\n';
      const template = '[tools]\nnode = "24"\n\n[settings]\nexperimental = true\nquiet = true\n';

      const result = merge(base, local, template, "config.toml");

      // node を両側が変更 → コンフリクト
      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
    });

    it("YAML: 同じキーを異なる値に変更 → コンフリクトマーカー必須", () => {
      const base = "name: my-app\nversion: 1.0\ndescription: original\n";
      const local = "name: my-app\nversion: 2.0\nauthor: me\ndescription: original\n";
      const template = "name: my-app\nversion: 3.0\ndescription: updated\n";

      const result = merge(base, local, template, "config.yml");

      // version を両側が変更 → コンフリクト
      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
    });
  });

  describe("根本原因調査: テンプレート変更のサイレント消失", () => {
    it("テンプレートの変更がローカルに既に含まれている場合でも、追加変更は消えない", () => {
      const base = JSON.stringify({ a: 1, b: 2 }, null, 2);
      const local = JSON.stringify({ a: 10, b: 20 }, null, 2);
      const template = JSON.stringify({ a: 10, b: 2 }, null, 2);

      const result = merge(base, local, template, "config.json");

      // 正しい結果: ローカルの内容がそのまま保持される
      // (テンプレートの a→10 は既に反映済み、ローカルの b→20 はローカル独自の変更)
      if (result._tag === "Clean") {
        const parsed = JSON.parse(result.content);
        expect(parsed.a).toBe(10);
        expect(parsed.b).toBe(20);
      }
      if (result._tag === "Conflicted") {
        expect(result.content).toContain("<<<<<<< LOCAL");
      }
    });

    it("TOML: テンプレートの変更がローカル変更と別キーなら Auto-merged で反映される", () => {
      const base = '[tools]\nnode = "20"\n';
      const local = '[tools]\nnode = "20"\npython = "3.12"\n';
      const template = '[tools]\nnode = "22"\n';

      const result = merge(base, local, template, "config.toml");

      if (result._tag === "Clean") {
        expect(result.content).toContain("python");
        expect(result.content).toContain('"22"');
      }
    });

    it("base === template の場合ローカルがそのまま返る", () => {
      const base = '{\n  "a": 1\n}';
      const local = '{\n  "a": 1,\n  "b": 2\n}';
      const template = '{\n  "a": 1\n}'; // template === base

      const result = merge(base, local, template, "settings.json");

      // base === template → テンプレート側に変更なし → ローカルをそのまま返すのが正しい
      expect(result._tag).toBe("Clean");
      expect(result.content).toBe(local);
    });

    it("TOML: 同じキーを異なる値に変更 → コンフリクトマーカー必須", () => {
      const base = '[tools]\nnode = "20"\n';
      const local = '[tools]\nnode = "22"\n';
      const template = '[tools]\nnode = "24"\n';

      const result = merge(base, local, template, ".mise.toml");

      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain(">>>>>>> TEMPLATE");
    });
  });

  describe("3-way merge の回帰テスト: サイレント上書き・内容二重化の防止", () => {
    it("settings.json: ローカルの true がテンプレートの false で上書きされない", () => {
      // base/template で false、local で true に変更した状態
      const base = JSON.stringify(
        {
          enabledPlugins: {
            "plugin-a": false,
            "plugin-b": false,
            "plugin-c": false,
          },
        },
        null,
        2,
      );
      const local = JSON.stringify(
        {
          enabledPlugins: {
            "plugin-a": true,
            "plugin-b": true,
            "plugin-c": false,
          },
        },
        null,
        2,
      );
      const template = JSON.stringify(
        {
          enabledPlugins: {
            "plugin-a": false,
            "plugin-b": false,
            "plugin-c": false,
            "plugin-d": false,
          },
        },
        null,
        2,
      );

      const result = merge(base, local, template, "settings.json");

      // ローカルの true 値がサイレントに上書きされてはならない
      // コンフリクトマーカーで明示されるか、ローカル値が保持される
      if (result._tag === "Conflicted") {
        // コンフリクト内にローカルの true が含まれるべき
        expect(result.content).toContain("true");
        expect(result.content).toContain("<<<<<<< LOCAL");
      } else {
        const parsed = JSON.parse(result.content);
        expect(parsed.enabledPlugins["plugin-a"]).toBe(true);
        expect(parsed.enabledPlugins["plugin-b"]).toBe(true);
      }
    });

    it("テキストファイル: 3者異なる同一行はコンフリクトとして検出される", () => {
      const base = "line1\noriginal-value\nline3\n";
      const local = "line1\nlocal-value\nline3\n";
      const template = "line1\ntemplate-value\nline3\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("local-value");
      expect(result.content).toContain("template-value");
      expect(result.content).toContain(">>>>>>> TEMPLATE");
    });

    it("空 base: ローカルとテンプレートの内容が二重化しない", () => {
      const base = "";
      const local = "line1\nline2\nline3\n";
      const template = "line1\nline2\nline3\nline4\n";

      const result = merge(base, local, template);

      // 内容の二重化チェック: line1 が2回以上出現しないこと
      const line1Count = (result.content.match(/line1/g) ?? []).length;
      // コンフリクトマーカー内で両側に含まれる場合は最大2回（LOCAL + TEMPLATE）
      expect(line1Count).toBeLessThanOrEqual(2);

      // 結果が base + local の単純結合（= 二重化）ではないこと
      const duplicatedContent = local + template;
      expect(result.content).not.toBe(duplicatedContent);
    });

    it("空 base: 両側が同一内容ならクリーンマージ", () => {
      const base = "";
      const local = "same content\n";
      const template = "same content\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toBe("same content\n");
    });

    it("テキストファイル: 離れた箇所の独立した変更はクリーンマージ", () => {
      const base = "header\nline1\nline2\nline3\nline4\nline5\nfooter\n";
      const local = "header-modified\nline1\nline2\nline3\nline4\nline5\nfooter\n";
      const template = "header\nline1\nline2\nline3\nline4\nline5\nfooter-updated\n";

      const result = merge(base, local, template);

      expect(result._tag).toBe("Clean");
      expect(result.content).toContain("header-modified");
      expect(result.content).toContain("footer-updated");
    });

    it("JSON: 同じキーを異なる値に変更 → コンフリクト", () => {
      const base = JSON.stringify({ version: "1.0", name: "app" }, null, 2);
      const local = JSON.stringify({ version: "2.0-local", name: "app" }, null, 2);
      const template = JSON.stringify({ version: "2.0-template", name: "app" }, null, 2);

      const result = merge(base, local, template, "package.json");

      expect(result._tag).toBe("Conflicted");
      expect(result.content).toContain("2.0-local");
      expect(result.content).toContain("2.0-template");
    });

    it("テンプレートがファイルを大幅に再構成してもローカルの値変更が消えない", () => {
      const base = ["# Config", "debug = false", "verbose = false", "# End"].join("\n");
      const local = ["# Config", "debug = true", "verbose = false", "# End"].join("\n");
      const template = [
        "# Config",
        "debug = false",
        "verbose = false",
        "log_level = info",
        "# End",
      ].join("\n");

      const result = merge(base, local, template);

      // debug = true（ローカルの変更）が結果に含まれるか、
      // コンフリクトマーカーの LOCAL 側に含まれること
      if (result._tag === "Conflicted") {
        expect(result.content).toContain("debug = true");
      } else {
        expect(result.content).toContain("debug = true");
        expect(result.content).toContain("log_level = info");
      }
    });
  });
});
