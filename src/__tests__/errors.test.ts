import { describe, expect, it } from "vitest";
import { ZikuError } from "../errors";

describe("ZikuError", () => {
  it("should create error with message", () => {
    const error = new ZikuError("something went wrong");
    expect(error.message).toBe("something went wrong");
    expect(error.name).toBe("ZikuError");
    expect(error.hint).toBeUndefined();
  });

  it("should create error with hint", () => {
    const error = new ZikuError("config not found", "Run 'ziku init' first.");
    expect(error.message).toBe("config not found");
    expect(error.hint).toBe("Run 'ziku init' first.");
  });

  it("should be instanceof Error", () => {
    const error = new ZikuError("test");
    expect(error).toBeInstanceOf(Error);
  });
});
