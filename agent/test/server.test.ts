import { expect, test } from "vitest";
import { app } from "../src/server.js";

test("reports service health", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
});

test("rejects chat requests without a message", async () => {
    const response = await app.request("/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
        error: "Message is required",
    });
});
