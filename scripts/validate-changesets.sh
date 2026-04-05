#!/usr/bin/env bash
# changeset ファイルの YAML frontmatter に書かれたパッケージ名が
# ワークスペース内に実在するか検証する。
#
# changeset version 時に初めてエラーになる問題を PR 段階で検知するためのスクリプト。
# CI (.github/workflows/changeset-check.yml) とローカル (pnpm lint:changesets) の
# 両方から呼ばれる。
#
# 環境変数でパスをオーバーライド可能（テスト用）:
#   CHANGESET_DIR — changeset ファイルのディレクトリ (default: .changeset)
#   PROJECT_ROOT  — package.json があるルート (default: .)

set -euo pipefail

CHANGESET_DIR="${CHANGESET_DIR:-.changeset}"
PROJECT_ROOT="${PROJECT_ROOT:-.}"

# --- ワークスペース内の有効なパッケージ名を収集 ---
collect_valid_packages() {
  local packages=()

  # pnpm workspace 対応: pnpm ls --json でワークスペース全パッケージを列挙
  if command -v pnpm &>/dev/null && pnpm ls --json &>/dev/null; then
    while IFS= read -r name; do
      [[ -n "$name" ]] && packages+=("$name")
    done < <(pnpm ls --json --depth -1 -r 2>/dev/null | node -e "
      const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const items = Array.isArray(data) ? data : [data];
      items.forEach(p => p.name && console.log(p.name));
    " 2>/dev/null || true)
  fi

  # pnpm ls が使えなかった or 結果が空の場合、package.json にフォールバック
  if [[ ${#packages[@]} -eq 0 ]]; then
    local root_name
    root_name=$(PROJECT_ROOT="$PROJECT_ROOT" node -e "
      const path = require('path');
      const pkgPath = path.join(process.env.PROJECT_ROOT, 'package.json');
      console.log(JSON.parse(require('fs').readFileSync(pkgPath, 'utf8')).name || '');
    " 2>/dev/null)
    [[ -n "$root_name" ]] && packages+=("$root_name")
  fi

  if [[ ${#packages[@]} -eq 0 ]]; then
    echo "error: ワークスペース内のパッケージ名を取得できませんでした" >&2
    exit 1
  fi

  printf '%s\n' "${packages[@]}"
}

# --- changeset ファイルからパッケージ名を抽出 ---
# YAML frontmatter の "package-name": bump 形式をパースする
extract_packages_from_changeset() {
  local file="$1"
  local in_frontmatter=false

  while IFS= read -r line; do
    if [[ "$line" == "---" ]]; then
      if $in_frontmatter; then
        # frontmatter 終了
        return
      else
        in_frontmatter=true
        continue
      fi
    fi
    if $in_frontmatter && [[ -n "$line" ]]; then
      # "package-name": major|minor|patch 形式からパッケージ名を抽出
      # クォート有無の両方に対応
      local pkg
      pkg=$(echo "$line" | sed -n 's/^"\([^"]*\)":\s*\(major\|minor\|patch\)\s*$/\1/p')
      if [[ -z "$pkg" ]]; then
        pkg=$(echo "$line" | sed -n "s/^'\([^']*\)':\s*\(major\|minor\|patch\)\s*$/\1/p")
      fi
      if [[ -z "$pkg" ]]; then
        pkg=$(echo "$line" | sed -n 's/^\([^:]*\):\s*\(major\|minor\|patch\)\s*$/\1/p')
      fi
      if [[ -n "$pkg" ]]; then
        echo "$pkg"
      fi
    fi
  done < "$file"
}

# --- メイン ---
main() {
  # changeset ファイルを収集（README.md を除外）
  local changeset_files=()
  for f in "${CHANGESET_DIR}"/*.md; do
    [[ -f "$f" ]] || continue
    [[ "$(basename "$f")" == "README.md" ]] && continue
    changeset_files+=("$f")
  done

  if [[ ${#changeset_files[@]} -eq 0 ]]; then
    echo "changeset ファイルなし — スキップ"
    exit 0
  fi

  # 有効なパッケージ名を取得
  local valid_packages
  valid_packages=$(collect_valid_packages)

  local has_error=false

  for file in "${changeset_files[@]}"; do
    local filename
    filename=$(basename "$file")
    local packages
    packages=$(extract_packages_from_changeset "$file")

    if [[ -z "$packages" ]]; then
      continue
    fi

    while IFS= read -r pkg; do
      if ! echo "$valid_packages" | grep -qxF "$pkg"; then
        echo "error: ${filename} が不明なパッケージ \"${pkg}\" を参照しています" >&2
        echo "  有効なパッケージ: $(echo "$valid_packages" | tr '\n' ', ' | sed 's/,$//')" >&2
        has_error=true
      fi
    done <<< "$packages"
  done

  if $has_error; then
    echo "" >&2
    echo "changeset のパッケージ名を修正してください。" >&2
    echo "package.json の \"name\" フィールドと一致する必要があります。" >&2
    exit 1
  fi

  echo "changeset パッケージ名の検証: OK (${#changeset_files[@]} ファイル)"
}

main "$@"
