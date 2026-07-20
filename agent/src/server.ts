import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { chat, MODEL_ID } from "./agent.js";
import type { UniversalEvent } from "./universal-event-types.js";
import { UniversalEventTranslator } from "./universal-events.js";

export const app = new Hono();

app.get("/health", (context) => context.json({ status: "ok" }));

app.get("/info", (context) =>
    context.json({
        agent_type: "pi-agent",
        model: MODEL_ID,
        capabilities: {
            system_prompt: false,
            mcp: false,
            skills: false,
            questions: false,
            reconnect: false,
            permissions: false,
            streaming_deltas: true,
        },
    }),
);

app.post("/chat", async (context) => {
    let body: unknown;
    try {
        body = await context.req.json();
    } catch {
        return context.json({ error: "Request body must be valid JSON" }, 400);
    }

    if (!isRecord(body) || typeof body.message !== "string") {
        return context.json({ error: "Message is required" }, 400);
    }

    const message = body.message.trim();
    if (!message) return context.json({ error: "Message is required" }, 400);

    if (body.session_id !== undefined && typeof body.session_id !== "string") {
        return context.json({ error: "session_id must be a string" }, 400);
    }

    const sessionId = body.session_id || randomUUID();
    const translator = new UniversalEventTranslator(sessionId);

    return streamSSE(context, async (stream) => {
        const writeEvent = async (event: UniversalEvent): Promise<void> => {
            await stream.writeSSE({
                event: "message",
                data: JSON.stringify(event),
            });
        };

        let pendingWrites = Promise.resolve();
        const enqueueEvents = (events: UniversalEvent[]): Promise<void> => {
            pendingWrites = pendingWrites.then(async () => {
                for (const event of events) await writeEvent(event);
            });
            return pendingWrites;
        };

        await writeEvent(translator.sessionStarted(sessionId));

        try {
            await chat({
                sessionId,
                userMessage: message,
                callbacks: {
                    onMessage: (event) =>
                        enqueueEvents(translator.translate(event)),
                },
            });
            await pendingWrites;
            await writeEvent(translator.sessionEnded("completed"));
        } catch (error) {
            await pendingWrites;
            await writeEvent(translator.error(errorMessage(error)));
            await writeEvent(translator.sessionEnded("error"));
        }
    });
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
