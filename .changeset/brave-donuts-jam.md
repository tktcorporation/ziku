---
"ziku": patch
---

`ziku aggregate` の候補ごとの commit SHA 解決（`resolveCandidateRef`）が、GitHub のレート制限（429、または secondary rate limit を示す `retry-after` 付きの 403）を汎用的な失敗と区別せずに扱っていたため、レート制限を検知しても owner 横断のスキャン全体で共有するレート制限ゲートを立てず、残りの候補へ問い合わせを送り続けていた。レート制限を専用の種別として分類し、検知した時点でゲートを立てて以降の候補への問い合わせを止めるようにした。
