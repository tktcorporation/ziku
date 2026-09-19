---
"ziku": patch
---

`ziku aggregate` の候補ごとの commit SHA 解決（`resolveCandidateRef`）・テンプレート固定リビジョンの検証（`checkPinnedRef`）・lock.json 取得（`fetchRepoTextFile`）・リポジトリ正規名解決（`getRepoIdentity`）・`--since` 指定時のコミット日時取得（`getLastCommitDate`）が、GitHub のレート制限（429、コアクォータ超過の 403、または secondary rate limit を示す 403）を汎用的な失敗と区別せずに扱っていたため、レート制限を検知しても owner 横断のスキャン全体で共有するレート制限ゲートを立てず、残りの候補へ問い合わせを送り続けていた。いずれも候補・ファイルをまたいで並行に呼ばれ、secondary rate limit を誘発しやすい経路。レート制限を専用の種別として分類し、検知した時点でゲートを立てて以降の候補への問い合わせを止めるようにした。secondary rate limit の 403 は `x-ratelimit-remaining` / `retry-after` ヘッダーを付けずに返ることがあるため、ヘッダーで判定できない場合はレスポンス本文の案内文も確認する。
