import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { UniversalEventTranslator } from "../src/universal-events.js";

test("builds lifecycle events through the translator", () => {
    const translator = new UniversalEventTranslator();
    const event = translator.sessionStarted("session-1");

    expect(event.type).toBe("session.started");
    expect(event.session_id).toBe("session-1");
});

test("starts the message item on the assistant message start event", () => {
    const translator = new UniversalEventTranslator("session-1");
    const startEvent = {
        type: "message_start",
        message: {
            role: "assistant",
            content: [],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "test-model",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
            stopReason: "stop",
            timestamp: 0,
        },
    } satisfies AgentSessionEvent;
    const endEvent = {
        type: "message_end",
        message: {
            ...startEvent.message,
            content: [{ type: "text", text: "Hello" }],
        },
    } satisfies AgentSessionEvent;

    const [started] = translator.translate(startEvent);
    const [completed] = translator.translate(endEvent);

    expect(started?.type).toBe("item.started");
    expect(started?.item?.item_id).toBe(completed?.item?.item_id);
    expect(completed?.item?.content[0]?.text).toBe("Hello");
});

test("translates a tool execution into a call and result pair", () => {
    const translator = new UniversalEventTranslator("session-1");
    const startEvent = {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "README.md" },
    } satisfies AgentSessionEvent;
    const endEvent = {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "Agent Hub" }] },
        isError: false,
    } satisfies AgentSessionEvent;

    const [started] = translator.translate(startEvent);
    const [completed, result] = translator.translate(endEvent);

    expect(started?.type).toBe("item.started");
    expect(started?.item?.content[0]?.arguments).toBe('{"path":"README.md"}');
    expect(completed?.item?.kind).toBe("tool_call");
    expect(result?.item?.kind).toBe("tool_result");
    expect(result?.item?.content[0]?.output).toBe("Agent Hub");
});
