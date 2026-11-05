import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { opt } from "./env";
import { log } from "./runtime";

export interface Stored {
  provider: "r2" | "cloudinary" | "supabase";
  key: string;
  url: string;
}

const BUCKET = "clips";

export function parseCloudinaryUrl(u = opt("CLOUDINARY_URL")): { cloud: string; key: string; secret: string } | null {
  const m = u?.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  return m ? { key: m[1], secret: m[2], cloud: m[3] } : null;
}

/** Cloudinary signature: sorted `k=v` pairs joined by &, secret appended, SHA-1. */
export function signParams(params: Record<string, string | number>, secret: string): string {
  const s = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return createHash("sha1").update(s + secret).digest("hex");
}

async function cloudinaryUpload(buf: Buffer, publicId: string): Promise<Stored> {
  const c = parseCloudinaryUrl()!;
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = { overwrite: "true", public_id: publicId, timestamp };
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(buf)], { type: "video/mp4" }), "clip.mp4");
  form.set("api_key", c.key);
  form.set("timestamp", String(timestamp));
  form.set("public_id", publicId);
  form.set("overwrite", "true");
  form.set("signature", signParams(signed, c.secret));
  const r = await fetch(`https://api.cloudinary.com/v1_1/${c.cloud}/video/upload`, { method: "POST", body: form });
  const j = (await r.json()) as { public_id?: string; secure_url?: string; error?: { message: string } };
  if (!r.ok || !j.secure_url) throw new Error(j.error?.message ?? `Cloudinary HTTP ${r.status}`);
  return { provider: "cloudinary", key: j.public_id!, url: j.secure_url };
}

// ---------------------------------------------------------------- Cloudflare R2 (S3-compatible)

export interface R2Cfg {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** R2_ACCOUNT_ID (or R2_ENDPOINT), R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. */
export function r2Config(env: NodeJS.ProcessEnv = process.env): R2Cfg | null {
  const endpoint = env.R2_ENDPOINT ?? (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint || !env.R2_BUCKET || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null;
  return { endpoint: endpoint.replace(/\/$/, ""), bucket: env.R2_BUCKET, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY };
}

const r2Url = (c: R2Cfg, key: string) => `${c.endpoint}/${c.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
const r2Client = (c: R2Cfg) => new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, service: "s3", region: "auto" });

async function r2Upload(buf: Buffer, key: string): Promise<Stored> {
  const c = r2Config()!;
  const obj = `${key}.mp4`;
  const r = await r2Client(c).fetch(r2Url(c, obj), { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: new Uint8Array(buf) });
  if (!r.ok) throw new Error(`R2 upload HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return { provider: "r2", key: obj, url: "" };
}

// ---------------------------------------------------------------- choosing where a clip goes

export type StorageName = "r2" | "cloudinary" | "supabase";

/** Providers to try, best first. STORAGE_PROVIDER=r2|cloudinary|supabase puts one first; unconfigured ones are skipped. */
export function storageOrder(env: NodeJS.ProcessEnv = process.env): StorageName[] {
  const avail: Record<StorageName, boolean> = { r2: Boolean(r2Config(env)), cloudinary: Boolean(parseCloudinaryUrl(env.CLOUDINARY_URL)), supabase: true };
  const base: StorageName[] = ["r2", "cloudinary", "supabase"];
  const forced = env.STORAGE_PROVIDER as StorageName | undefined;
  const order = forced && base.includes(forced) ? [forced, ...base.filter((x) => x !== forced)] : base;
  return order.filter((p) => avail[p]);
}

/** Cloudflare R2 or Cloudinary first; Supabase Storage as the last resort when they are unset, failing, or over quota. */
export async function uploadClip(buf: Buffer, key: string): Promise<Stored> {
  const errors: string[] = [];
  for (const name of storageOrder()) {
    try {
      if (name === "r2") return await r2Upload(buf, key);
      if (name === "cloudinary") return await cloudinaryUpload(buf, key);
      const { sb } = await import("./db");
      const obj = `${key}.mp4`;
      const { error } = await sb().storage.from(BUCKET).upload(obj, buf, { contentType: "video/mp4", upsert: true });
      if (error) throw new Error(`Supabase upload failed: ${error.message}`);
      return { provider: "supabase", key: obj, url: "" };
    } catch (e) {
      errors.push(`${name}: ${String((e as Error).message).slice(0, 150)}`);
      log.warn(`${name} upload failed; trying the next storage`);
    }
  }
  throw new Error(`could not store the clip (${errors.join(" | ")})`);
}

export async function fetchClip(provider: string, key: string, url: string): Promise<Buffer> {
  if (provider === "r2") {
    const c = r2Config();
    if (!c) throw new Error("R2 is not configured");
    const r = await r2Client(c).fetch(r2Url(c, key));
    if (!r.ok) throw new Error(`R2 download HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  if (provider === "cloudinary") {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const { sb } = await import("./db");
  const { data, error } = await sb().storage.from(BUCKET).download(key);
  if (error || !data) throw new Error(`Supabase download failed: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function deleteClip(provider: string, key: string): Promise<void> {
  if (provider === "r2") {
    const c = r2Config();
    if (!c) return;
    const r = await r2Client(c).fetch(r2Url(c, key), { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error(`R2 delete HTTP ${r.status}`);
    return;
  }
  if (provider === "cloudinary") {
    const c = parseCloudinaryUrl();
    if (!c) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const form = new FormData();
    form.set("public_id", key);
    form.set("timestamp", String(timestamp));
    form.set("api_key", c.key);
    form.set("signature", signParams({ public_id: key, timestamp }, c.secret));
    const r = await fetch(`https://api.cloudinary.com/v1_1/${c.cloud}/video/destroy`, { method: "POST", body: form });
    if (!r.ok) throw new Error(`Cloudinary destroy HTTP ${r.status}`);
    return;
  }
  const { sb } = await import("./db");
  await sb().storage.from(BUCKET).remove([key]);
}
