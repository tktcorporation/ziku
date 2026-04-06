---
"ziku": patch
---

fix: ziku push 時の GitHub API 404 ログノイズを解消

getContent による個別ファイル存在確認を getTree による一括取得に置き換え、
@octokit/plugin-request-log が 404 レスポンスをコンソール出力する問題を根本的に解消。
