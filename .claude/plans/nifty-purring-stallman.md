# Fix: `ziku push` 時の GitHub API 404 ログノイズを解消

## Context

`ziku push` で PR 作成時、fork のブランチに存在しないファイルを `octokit.repos.getContent()` で1つずつ確認するため、期待通りの 404 がコンソールに表示される。`@octokit/plugin-request-log`（`@octokit/rest` v22 にバンドル）が HTTP レスポンスをログ出力するのが原因。

## アプローチ: Git Trees API で統一的に 404 を回避

ファイルごとに `getContent()` を呼ぶ代わりに、`git.getTree()` で一括取得して SHA を Map で引く。
フォールバック分岐は設けず、処理を1パスに統一する。

- 404 が発生しなくなる（根本解決）
- API コール数が N → 1 に削減
- `truncated: true` の場合はエラーで止める（テンプレートリポジトリで発生することは事実上ない）
- `getContent` の呼び出しは完全に削除

## 変更対象

### 1. `src/utils/github.ts` (lines 57-86)

ブランチ作成後に `getTree` を1回呼び、SHA の Map を構築。ファイルループでは Map から引くだけ:

```typescript
// 6. 既存ファイルの SHA を一括取得（getContent の 404 ログを回避）
const { data: treeData } = await octokit.git.getTree({
  owner: forkOwner,
  repo: forkRepo,
  tree_sha: branchName,
  recursive: "true",
});
if (treeData.truncated) {
  throw new Error(
    `Repository tree is too large to fetch entirely. ` +
    `Consider reducing the number of files in ${forkOwner}/${forkRepo}.`,
  );
}
const shaMap = new Map(
  treeData.tree
    .filter((item): item is typeof item & { sha: string } =>
      item.type === "blob" && item.sha != null)
    .map((item) => [item.path!, item.sha]),
);

// 7. ファイルを更新
for (const file of files) {
  await octokit.repos.createOrUpdateFileContents({
    owner: forkOwner,
    repo: forkRepo,
    path: file.path,
    message: `Update ${file.path}`,
    content: Buffer.from(file.content).toString("base64"),
    branch: branchName,
    sha: shaMap.get(file.path),
  });
}
```

- `getContent` の呼び出しは完全に削除
- PR 作成のステップ番号を 7→8 に繰り下げ

### 2. `src/utils/__tests__/github.test.ts`

- `mockGitGetTree` を追加し、mock Octokit の `git` に `getTree` を追加
- `beforeEach` にデフォルトの空 tree（`truncated: false`）mock を追加
- 「既存ファイルを更新する」テストを tree mock に変更（`getContent` mock → `getTree` mock）
- `mockReposGetContent` は不要になるため削除
- 新規テスト: `getContent` が呼ばれないことを検証
- 新規テスト: `truncated: true` 時にエラーが throw されることを検証

## 検証

1. `pnpm test` でテスト通過
2. CI チェック（lint, knip, build）通過
3. `ziku push` 実行時に 404 ログが出ないことを確認（手動）
