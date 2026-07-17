import { serve } from "@hono/node-server";
import { app } from "./server";

const DEFAULT_PORT = 3001;
const port = parsePort(process.env.PORT);
serve({ fetch: app.fetch, port });

function parsePort(value: string | undefined): number {
    if (value === undefined) return DEFAULT_PORT;

    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) {
        return parsed;
    }

    throw new Error(`Invalid PORT: ${value}`);
}
