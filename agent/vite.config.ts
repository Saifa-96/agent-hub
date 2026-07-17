import devServer from "@hono/vite-dev-server";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
});
