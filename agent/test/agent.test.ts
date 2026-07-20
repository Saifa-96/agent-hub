import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

test("runs a real agent session", async () => {
    if (!process.env.DEEPSEEK_API_KEY) {
        throw new Error("DEEPSEEK_API_KEY is required for agent tests");
    }

    const { chat } = await import("../src/agent");
    let responseText = "";

    const result = await chat({
        sessionId: randomUUID(),
        userMessage: "Reply with exactly: pong",
        callbacks: {
            onMessage: (event: AgentSessionEvent) => {
                if (event.type !== "message_update") return;
                if (event.assistantMessageEvent.type !== "text_delta") {
                    return;
                }
                responseText += event.assistantMessageEvent.delta;
            },
        },
    });

    expect(result.sessionId).toBeTruthy();
    expect(responseText.trim().toLowerCase()).toBe("pong");
}, 120_000);
