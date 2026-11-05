import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const yml = fs.readFileSync(path.join(__dirname, "../render.yaml"), "utf8");

describe("render.yaml", () => {
  it("is a Docker background worker built from the repo Dockerfile", () => {
    expect(yml).toMatch(/type: worker/);
    expect(yml).toMatch(/runtime: docker/);
    expect(yml).toMatch(/dockerfilePath: \.\/Dockerfile/);
    expect(fs.existsSync(path.join(__dirname, "../Dockerfile"))).toBe(true);
  });
  it("asks for the required secrets without storing values in the repo", () => {
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CLOUDINARY_URL"]) {
      expect(yml).toMatch(new RegExp(`- key: ${key}\\n\\s+sync: false`));
    }
  });
});
