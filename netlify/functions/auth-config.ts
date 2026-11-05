import type { Config } from "@netlify/functions";
import { publicAuthConfig } from "../../src/auth";
import { json } from "../../src/http";

/** Public: tells the dashboard whether email sign-in is available. The anon key is meant to be public. */
export default async () => json(publicAuthConfig());

export const config: Config = { path: "/api/auth/config" };
