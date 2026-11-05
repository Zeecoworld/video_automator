import type { Config } from "@netlify/functions";
import { trigger } from "../../src/http";

export default async () => {
  await trigger("publish-background");
};

export const config: Config = { schedule: "*/30 * * * *" };
