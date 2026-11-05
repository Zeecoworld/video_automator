import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { deleteClip, fetchClip, r2Config, storageOrder, uploadClip } from "../src/storage";

const KEYS = ["R2_ACCOUNT_ID", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDINARY_URL", "STORAGE_PROVIDER"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])); });

describe("storage order", () => {
  it("prefers R2, then Cloudinary, then Supabase, skipping what is not configured", () => {
    expect(storageOrder({})).toEqual(["supabase"]);
    expect(storageOrder({ CLOUDINARY_URL: "cloudinary://k:s@c" })).toEqual(["cloudinary", "supabase"]);
    const r2 = { R2_ACCOUNT_ID: "acct", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "sec" };
    expect(storageOrder({ ...r2, CLOUDINARY_URL: "cloudinary://k:s@c" })).toEqual(["r2", "cloudinary", "supabase"]);
    expect(storageOrder({ ...r2, CLOUDINARY_URL: "cloudinary://k:s@c", STORAGE_PROVIDER: "cloudinary" })).toEqual(["cloudinary", "r2", "supabase"]);
    expect(r2Config({ ...r2 })?.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(r2Config({ R2_BUCKET: "b" })).toBeNull();
  });
});

describe("Cloudflare R2 round trip (mock S3 server)", () => {
  it("uploads with a signed request, downloads, and deletes", async () => {
    const files = new Map<string, Buffer>();
    const auth: string[] = [];
    const s = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        auth.push(String(req.headers.authorization));
        const p = decodeURIComponent(req.url!);
        if (req.method === "PUT") { files.set(p, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
        if (req.method === "GET") { const f = files.get(p); res.writeHead(f ? 200 : 404); return res.end(f); }
        if (req.method === "DELETE") { files.delete(p); res.writeHead(204); return res.end(); }
        res.writeHead(405); res.end();
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    Object.assign(process.env, { R2_ENDPOINT: `http://127.0.0.1:${(s.address() as { port: number }).port}`, R2_BUCKET: "clips", R2_ACCESS_KEY_ID: "AKIDEXAMPLE", R2_SECRET_ACCESS_KEY: "secret" });
    delete process.env.CLOUDINARY_URL;
    try {
      const data = Buffer.from("video-bytes-123");
      const stored = await uploadClip(data, "clip-engine/youtube/abc");
      expect(stored).toEqual({ provider: "r2", key: "clip-engine/youtube/abc.mp4", url: "" });
      expect(files.get("/clips/clip-engine/youtube/abc.mp4")).toEqual(data);
      expect(auth[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
      expect(await fetchClip("r2", stored.key, "")).toEqual(data);
      await deleteClip("r2", stored.key);
      expect(files.size).toBe(0);
      await expect(fetchClip("r2", stored.key, "")).rejects.toThrow(/404/);
      await deleteClip("r2", stored.key); // deleting twice is fine
    } finally { s.close(); }
  });
});
