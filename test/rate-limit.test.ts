import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedWindowLimiter } from "../src/rate-limit.js";

describe("FixedWindowLimiter", () => {
  it("allows up to the limit then rejects within the window", () => {
    const limiter = new FixedWindowLimiter(3, 60_000);
    assert.equal(limiter.hit("a"), true);
    assert.equal(limiter.hit("a"), true);
    assert.equal(limiter.hit("a"), true);
    assert.equal(limiter.hit("a"), false);
  });

  it("tracks keys independently", () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    assert.equal(limiter.hit("a"), true);
    assert.equal(limiter.hit("a"), false);
    assert.equal(limiter.hit("b"), true);
  });

  it("resets after the window elapses", async () => {
    const limiter = new FixedWindowLimiter(1, 25);
    assert.equal(limiter.hit("a"), true);
    assert.equal(limiter.hit("a"), false);
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(limiter.hit("a"), true);
  });
});