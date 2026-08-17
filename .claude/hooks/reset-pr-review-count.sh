#!/usr/bin/env bash
# PostToolUse フック: gh pr create が exit 0 で完了した後にセルフレビューカウンターを
# リセットする。PostToolUse は成功時にのみ発火する（非ゼロ終了・許可拒否では発火しない）
# ため、実際に PR を作成できたときだけリセットされる。
#
# 呼び出し元の settings.json 側で gh pr create にマッチした場合のみこのスクリプトを
# 起動するため、ここでは再判定せずリセットのみ行う。

set -euo pipefail

REVIEW_COUNT_FILE="${CLAUDE_PROJECT_DIR:-.}/.claude/.pr-review-count"
rm -f "$REVIEW_COUNT_FILE"
exit 0
