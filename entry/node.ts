import { serve } from "@hono/node-server";
import { createApp } from "../src/app.ts";
import type { Env } from "../src/types.ts";

const app = createApp();

serve({
  fetch: (request) =>
    app.fetch(request, {
      API_KEY: process.env.API_KEY ?? "",
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      TZ_OFFSET: process.env.TZ_OFFSET,
    } satisfies Env),
  port: Number(process.env.PORT) || 8000,
});

