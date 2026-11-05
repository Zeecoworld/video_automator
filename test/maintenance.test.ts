import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shouldFallback } from "../src/maintenance";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe("when the GitHub backup steps in", () => {
  it("only when a link has waited too long and no worker holds the lock", () => {
    expect(shouldFallback([], null, NOW, 45)).toBe(false);
    expect(shouldFallback([{ status: "pending", created_at: ago(10), updated_at: ago(10) }], null, NOW, 45)).toBe(false);
    expect(shouldFallback([{ status: "pending", created_at: ago(60), updated_at: ago(60) }], null, NOW, 45)).toBe(true);
    expect(shouldFallback([{ status: "pending", created_at: ago(60), updated_at: ago(60) }], `${NOW + 600_000}|abc`, NOW, 45)).toBe(false); // Modal is working
    expect(shouldFallback([{ status: "pending", created_at: ago(60), updated_at: ago(60) }], `${NOW - 1000}|abc`, NOW, 45)).toBe(true); // stale lock
    expect(shouldFallback([{ status: "pending", created_at: ago(60), updated_at: ago(60) }], "0|released", NOW, 45)).toBe(true);
  });
  it("judges a half-finished link by its last update, not when it was added", () => {
    expect(shouldFallback([{ status: "processing", created_at: ago(500), updated_at: ago(5) }], null, NOW, 45)).toBe(false);
    expect(shouldFallback([{ status: "processing", created_at: ago(500), updated_at: ago(90) }], null, NOW, 45)).toBe(true);
  });
});

describe("workflows", () => {
  const wf = fs.readFileSync(path.join(__dirname, "../.github/workflows/maintenance.yml"), "utf8");
  it("runs maintenance on a schedule and the processing fallback only when needed", () => {
    expect(wf).toMatch(/schedule:/);
    expect(wf).toMatch(/npm run maintenance/);
    expect(wf).toMatch(/npm run fallback:check/);
    expect(wf).toMatch(/needs\.maintenance\.outputs\.fallback == 'true'/);
    expect(wf).toMatch(/LOCAL_WHISPER: "off"/);
  });
  it("never has the manual worker run on a schedule", () => {
    const manual = fs.readFileSync(path.join(__dirname, "../.github/workflows/worker.yml"), "utf8");
    expect(manual).not.toMatch(/schedule:/);
  });
});
