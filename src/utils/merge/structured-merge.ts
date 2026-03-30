import { applyEdits, modify, parse as jsoncParse } from "jsonc-parser";
import * as TOML from "smol-toml";
import * as YAML from "yaml";
import type { ConflictDetail, MergeResult } from "./types";

// ---- JSON/JSONC 構造マージ ----

/**
 * JSON/JSONC ファイルをキーレベルで 3-way マージする。
 *
 * 背景: JSON ファイルにコンフリクトマーカーを挿入するとパーサーが壊れるため、
 * キーレベルで変更を検出し、非コンフリクト部分を自動マージする。
 * コンフリクトがあるキーはローカル値を採用し、conflictDetails で報告する。
 * jsonc-parser の modify/applyEdits を使い、ローカルのフォーマットとコメントを保持する。
 *
 * @returns マージ結果。JSON パースに失敗した場合は null（テキストマージにフォールバック）。
 */
export function mergeJsonContent(
  base: string,
  local: string,
  template: string,
): MergeResult | null {
  let baseObj: unknown;
  let localObj: unknown;
  let templateObj: unknown;

  try {
    baseObj = jsoncParse(base);
    localObj = jsoncParse(local);
    templateObj = jsoncParse(template);
  } catch {
    return null;
  }

  // パースできたが値が null/undefined の場合はフォールバック
  if (baseObj == null || localObj == null || templateObj == null) {
    return null;
  }

  // base→template の変更を検出
  const templateDiffs = getJsonDiffs(baseObj, templateObj);
  // base→local の変更を検出
  const localDiffs = getJsonDiffs(baseObj, localObj);

  // テンプレート変更のうち、ローカルとコンフリクトしないものを適用
  let result = local;
  const conflictDetails: ConflictDetail[] = [];

  for (const diff of templateDiffs) {
    // ローカルも同じパスまたは祖先/子孫を変更しているかチェック
    const conflictsWithLocal = localDiffs.some((ld) => pathsOverlap(ld.path, diff.path));

    if (conflictsWithLocal) {
      // ローカル値を取得
      const localVal = getValueAtPath(localObj, diff.path);
      const templateVal = diff.type === "remove" ? undefined : diff.value;

      if (deepEqual(localVal, templateVal)) {
        // 同じ値に変更 → コンフリクトなし
        continue;
      }

      // 真のコンフリクト: ローカル値を保持し、コンフリクト情報を記録
      conflictDetails.push({
        path: diff.path,
        localValue: localVal,
        templateValue: templateVal,
      });
      continue;
    }

    // テンプレートのみの変更 → ローカルに適用
    if (diff.type === "remove") {
      const edits = modify(result, diff.path as (string | number)[], undefined, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      });
      result = applyEdits(result, edits);
    } else {
      const edits = modify(result, diff.path as (string | number)[], diff.value, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      });
      result = applyEdits(result, edits);
    }
  }

  return {
    content: result,
    hasConflicts: conflictDetails.length > 0,
    conflictDetails,
  };
}

// ---- TOML 構造マージ ----

/**
 * TOML ファイルをキーレベルで 3-way マージする。
 *
 * 制約: smol-toml の stringify はコメントを保持しないため、マージ結果では
 * ローカルのコメントが失われる。正しい TOML を出力することを優先する。
 *
 * @returns マージ結果。TOML パースに失敗した場合は null（テキストマージにフォールバック）。
 */
export function mergeTomlContent(
  base: string,
  local: string,
  template: string,
): MergeResult | null {
  let baseObj: Record<string, unknown>;
  let localObj: Record<string, unknown>;
  let templateObj: Record<string, unknown>;

  try {
    baseObj = TOML.parse(base) as Record<string, unknown>;
    localObj = TOML.parse(local) as Record<string, unknown>;
    templateObj = TOML.parse(template) as Record<string, unknown>;
  } catch {
    return null;
  }

  return mergeObjects(baseObj, localObj, templateObj, (merged) => TOML.stringify(merged));
}

// ---- YAML 構造マージ ----

/**
 * YAML ファイルをキーレベルで 3-way マージする。
 *
 * @returns マージ結果。YAML パースに失敗した場合は null（テキストマージにフォールバック）。
 */
export function mergeYamlContent(
  base: string,
  local: string,
  template: string,
): MergeResult | null {
  let baseObj: unknown;
  let localObj: unknown;
  let templateObj: unknown;

  try {
    baseObj = YAML.parse(base);
    localObj = YAML.parse(local);
    templateObj = YAML.parse(template);
  } catch {
    return null;
  }

  if (baseObj == null || localObj == null || templateObj == null) {
    return null;
  }

  if (
    typeof baseObj !== "object" ||
    typeof localObj !== "object" ||
    typeof templateObj !== "object"
  ) {
    return null;
  }

  return mergeObjects(
    baseObj as Record<string, unknown>,
    localObj as Record<string, unknown>,
    templateObj as Record<string, unknown>,
    (merged) => YAML.stringify(merged),
  );
}

// ---- 共通オブジェクトマージ（TOML/YAML 共有） ----

/**
 * パース済みオブジェクトをキーレベルで 3-way マージし、stringify して返す。
 * TOML と YAML の共通ロジックを抽出したもの。
 */
function mergeObjects(
  baseObj: Record<string, unknown>,
  localObj: Record<string, unknown>,
  templateObj: Record<string, unknown>,
  stringify: (merged: Record<string, unknown>) => string,
): MergeResult {
  const templateDiffs = getJsonDiffs(baseObj, templateObj);
  const localDiffs = getJsonDiffs(baseObj, localObj);

  const mergedObj = structuredClone(localObj);
  const conflictDetails: ConflictDetail[] = [];

  for (const diff of templateDiffs) {
    const conflictsWithLocal = localDiffs.some((ld) => pathsOverlap(ld.path, diff.path));

    if (conflictsWithLocal) {
      const localVal = getValueAtPath(localObj, diff.path);
      const templateVal = diff.type === "remove" ? undefined : diff.value;

      if (deepEqual(localVal, templateVal)) {
        continue;
      }

      conflictDetails.push({
        path: diff.path,
        localValue: localVal,
        templateValue: templateVal,
      });
      continue;
    }

    if (diff.type === "remove") {
      deleteAtPath(mergedObj, diff.path);
    } else {
      setAtPath(mergedObj, diff.path, diff.value);
    }
  }

  return {
    content: stringify(mergedObj),
    hasConflicts: conflictDetails.length > 0,
    conflictDetails,
  };
}

// ---- diff 検出・比較ヘルパー ----

interface JsonDiff {
  path: (string | number)[];
  type: "add" | "remove" | "replace";
  value?: unknown;
}

/**
 * 2つの JSON 値の差分をパス単位で検出する。
 * オブジェクトはキーレベルで再帰比較し、配列はアトミックに扱う。
 */
function getJsonDiffs(base: unknown, target: unknown, path: (string | number)[] = []): JsonDiff[] {
  if (deepEqual(base, target)) return [];

  if (
    typeof base !== typeof target ||
    base === null ||
    target === null ||
    typeof base !== "object" ||
    typeof target !== "object" ||
    Array.isArray(base) !== Array.isArray(target)
  ) {
    return [{ path, type: "replace", value: target }];
  }

  // 配列はアトミックに扱う（要素単位の対応付けが困難なため）
  if (Array.isArray(base)) {
    return [{ path, type: "replace", value: target }];
  }

  const diffs: JsonDiff[] = [];
  const baseObj = base as Record<string, unknown>;
  const targetObj = target as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(baseObj), ...Object.keys(targetObj)]);

  for (const key of allKeys) {
    const childPath = [...path, key];
    if (!(key in baseObj)) {
      diffs.push({ path: childPath, type: "add", value: targetObj[key] });
    } else if (!(key in targetObj)) {
      diffs.push({ path: childPath, type: "remove" });
    } else {
      diffs.push(...getJsonDiffs(baseObj[key], targetObj[key], childPath));
    }
  }

  return diffs;
}

/**
 * 2つのパスが重複（祖先/子孫/同一）するかを判定する。
 * 例: ["a", "b"] と ["a", "b", "c"] → true（祖先と子孫）
 */
function pathsOverlap(pathA: (string | number)[], pathB: (string | number)[]): boolean {
  const minLen = Math.min(pathA.length, pathB.length);
  for (let i = 0; i < minLen; i++) {
    if (pathA[i] !== pathB[i]) return false;
  }
  return true;
}

/** ネストされたオブジェクトからパスを辿って値を取得する */
function getValueAtPath(obj: unknown, path: (string | number)[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** 2つの値を深い比較で等しいか判定する */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
}

// ---- オブジェクト操作ヘルパー ----

/**
 * ネストされたオブジェクトのパスに値を設定する。
 * 中間オブジェクトが存在しない場合は自動的に作成する。
 */
function setAtPath(obj: Record<string, unknown>, path: (string | number)[], value: unknown): void {
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (current == null || typeof current !== "object") return;
    const record = current as Record<string | number, unknown>;
    if (!(key in record) || record[key] == null || typeof record[key] !== "object") {
      record[key] = {};
    }
    current = record[key];
  }
  if (current != null && typeof current === "object") {
    (current as Record<string | number, unknown>)[path[path.length - 1]] = value;
  }
}

/** ネストされたオブジェクトのパスにあるキーを削除する */
function deleteAtPath(obj: Record<string, unknown>, path: (string | number)[]): void {
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (current == null || typeof current !== "object") return;
    current = (current as Record<string | number, unknown>)[key];
  }
  if (current != null && typeof current === "object") {
    delete (current as Record<string | number, unknown>)[path[path.length - 1]];
  }
}
