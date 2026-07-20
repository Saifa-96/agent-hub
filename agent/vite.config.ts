import { resolve } from "node:path";
import devServer from "@hono/vite-dev-server";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const ENV_ROOT = resolve(import.meta.dirname, "..");

export default defineConfig(({ command, mode }) => {
    Object.assign(process.env, loadEnv(mode, ENV_ROOT, ""));

    return {
        define: {
            "process.env.NODE_ENV": JSON.stringify(
                command === "build" ? "production" : "development",
            ),
        },
        plugins: [
            devServer({
                entry: "src/server.ts",
                export: "app",
            }),
        ],
        server: {
            port: 3001,
            strictPort: true,
        },
        build: {
            emptyOutDir: true,
            outDir: "dist",
            sourcemap: true,
            ssr: "src/index.ts",
            target: "node24",
        },
        test: {
            environment: "node",
            include: ["test/**/*.test.ts"],
        },
    };
});
