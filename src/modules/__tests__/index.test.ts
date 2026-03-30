import { describe, expect, it } from "vitest";
import {
	getAllPatterns,
	getModuleById,
	getPatternsByModuleIds,
} from "../index";

const sampleModules = [
	{
		id: "a",
		name: "A",
		description: "Module A",
		patterns: ["a.txt", "a.json"],
	},
	{ id: "b", name: "B", description: "Module B", patterns: ["b.txt"] },
	{ id: "c", name: "C", description: "Module C", patterns: ["c.txt"] },
];

describe("getModuleById", () => {
	it("ID でモジュールを取得できる", () => {
		const result = getModuleById("a", sampleModules);
		expect(result?.id).toBe("a");
		expect(result?.name).toBe("A");
	});

	it("存在しない ID の場合は undefined を返す", () => {
		const result = getModuleById("nonexistent", sampleModules);
		expect(result).toBeUndefined();
	});

	it("空のモジュールリストから取得すると undefined を返す", () => {
		const result = getModuleById("a", []);
		expect(result).toBeUndefined();
	});
});

describe("getAllPatterns", () => {
	it("全モジュールのパターンを取得する", () => {
		const patterns = getAllPatterns(sampleModules);
		expect(patterns).toEqual(["a.txt", "a.json", "b.txt", "c.txt"]);
	});

	it("空のモジュールリストの場合は空配列を返す", () => {
		const patterns = getAllPatterns([]);
		expect(patterns).toEqual([]);
	});

	it("パターンのないモジュールを含む場合も動作する", () => {
		const customModules = [
			{ id: "a", name: "A", description: "A", patterns: ["a.txt"] },
			{ id: "b", name: "B", description: "B", patterns: [] },
		];

		const patterns = getAllPatterns(customModules);
		expect(patterns).toEqual(["a.txt"]);
	});
});

describe("getPatternsByModuleIds", () => {
	it("指定したモジュール ID のパターンのみを返す", () => {
		const patterns = getPatternsByModuleIds(["a", "c"], sampleModules);
		expect(patterns).toEqual(["a.txt", "a.json", "c.txt"]);
	});

	it("存在しないモジュール ID は無視する", () => {
		const patterns = getPatternsByModuleIds(
			["a", "nonexistent"],
			sampleModules,
		);
		expect(patterns).toEqual(["a.txt", "a.json"]);
	});

	it("空のモジュール ID リストの場合は空配列を返す", () => {
		const patterns = getPatternsByModuleIds([], sampleModules);
		expect(patterns).toEqual([]);
	});

	it("全モジュール ID を指定すると全パターンを返す", () => {
		const patterns = getPatternsByModuleIds(["a", "b", "c"], sampleModules);
		expect(patterns).toEqual(["a.txt", "a.json", "b.txt", "c.txt"]);
	});
});
