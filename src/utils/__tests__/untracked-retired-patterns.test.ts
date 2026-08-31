/**
 * 追跡候補の提示が、宣言から落ちたパターンとどう噛み合うかを確かめる。
 *
 * テンプレートがパターンを外した実行では、そのパターンに一致するファイルは宣言の外にあるが、
 * 同じ実行でテンプレート側の削除を適用するかを問われている最中でもある。追跡候補として同時に
 * 見せると「削除しますか」と「追跡しますか」が並ぶ。
 */
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => (await import("memfs")).fs);
vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

vi.mock("tinyglobby", async () => {
  const { globMemfs } = await import("../../__tests__/glob-memfs");
  return {
    glob: vi.fn((patterns: string[], opts: { cwd: string; ignore?: string[] }) =>
      Promise.resolve(globMemfs(patterns, opts)),
    ),
    globSync: vi.fn((patterns: string[], opts: { cwd: string; ignore?: string[] }) =>
      globMemfs(patterns, opts),
    ),
  };
});

const { absPath, syncScope } = await import("../../__tests__/brands");
const { detectUntrackedFiles } = await import("../untracked");

const PROJECT_DIR = "/project";

/** 追跡候補として提示されたパスを平坦に取り出す。 */
async function untrackedPaths(scope: Parameters<typeof detectUntrackedFiles>[0]["scope"]) {
  const byFolder = await detectUntrackedFiles({ targetDir: absPath(PROJECT_DIR), scope });
  return byFolder.flatMap((folder) => folder.files.map((file) => file.path));
}

describe("detectUntrackedFiles と、宣言から落ちたパターン", () => {
  beforeEach(() => {
    vol.reset();
    vol.fromJSON({
      [`${PROJECT_DIR}/hooks/build.sh`]: "#!/bin/bash\n",
      [`${PROJECT_DIR}/hooks/build.ts`]: "export {};\n",
      [`${PROJECT_DIR}/hooks/notes.md`]: "# notes\n",
    });
  });

  it("宣言の外のファイルは追跡候補として提示する", () => {
    const scope = syncScope({ include: ["hooks/*.ts"] });

    return expect(untrackedPaths(scope)).resolves.toEqual(["hooks/build.sh", "hooks/notes.md"]);
  });

  it("テンプレートが今回外したパターンに一致するファイルは提示しない", async () => {
    // `hooks/*.sh` は削除を適用するか問われている最中。残す判断をすれば、次の実行では
    // 走査からも消えて通常の未追跡ファイルとして現れる。
    const scope = syncScope({ include: ["hooks/*.ts"], retired: ["hooks/*.sh"] });

    await expect(untrackedPaths(scope)).resolves.toEqual(["hooks/notes.md"]);
  });
});
