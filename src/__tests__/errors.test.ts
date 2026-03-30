import { describe, expect, it } from "vitest";
import { BermError } from "../errors";

describe("BermError", () => {
  it("should create error with message", () => {
    const error = new BermError("something went wrong");
    expect(error.message).toBe("something went wrong");
    expect(error.name).toBe("BermError");
    expect(error.hint).toBeUndefined();
  });

  it("should create error with hint", () => {
    const error = new BermError("config not found", "Run 'ziku init' first.");
    expect(error.message).toBe("config not found");
    expect(error.hint).toBe("Run 'ziku init' first.");
  });

  it("should be instanceof Error", () => {
    const error = new BermError("test");
    expect(error).toBeInstanceOf(Error);
  });
});
