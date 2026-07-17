import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { match } from "ts-pattern";
import type {
    ContentDelta,
    ContentPart,
    TurnStats,
    UniversalEvent,
    UniversalItem,
} from "./universal-event-types";

const eventBuilder = {
    sessionStarted(sessionId: string, timestamp: number): UniversalEvent {
        return { type: "session.started", timestamp, session_id: sessionId };
    },
    sessionEnded(
        sessionId: string | undefined,
        timestamp: number,
        reason: "completed" | "error" | "interrupted",
        stats?: TurnStats,
    ): UniversalEvent {
        return {
            type: "session.ended",
            timestamp,
            session_id: sessionId,
            reason,
            stats,
        };
    },
    error(
        sessionId: string | undefined,
        timestamp: number,
        message: string,
        code?: string,
    ): UniversalEvent {
        return {
            type: "error",
            timestamp,
            session_id: sessionId,
            message,
            code,
        };
    },
    itemStarted(
        sessionId: string | undefined,
        timestamp: number,
        item: UniversalItem,
    ): UniversalEvent {
        return { type: "item.started", timestamp, session_id: sessionId, item };
    },
    itemDelta(
        sessionId: string | undefined,
        timestamp: number,
        itemId: string,
        delta: ContentDelta,
    ): UniversalEvent {
        return {
            type: "item.delta",
            timestamp,
            session_id: sessionId,
            item_id: itemId,
            delta,
        };
    },
    itemCompleted(
        sessionId: string | undefined,
        timestamp: number,
        item: UniversalItem,
    ): UniversalEvent {
        return {
            type: "item.completed",
            timestamp,
            session_id: sessionId,
            item,
        };
    },
    item(
        itemId: string,
        kind: UniversalItem["kind"],
        role: UniversalItem["role"],
        status: UniversalItem["status"],
        content: ContentPart[],
    ): UniversalItem {
        return { item_id: itemId, kind, role, status, content };
    },
};

/**
 * Converts pi session events into the platform UniversalEvent protocol.
 */
export class UniversalEventTranslator {
    private sessionId?: string;
    private currentMessageItem?: UniversalItem;
    private readonly toolItems = new Map<string, UniversalItem>();

    public constructor(sessionId?: string) {
        this.sessionId = sessionId;
    }

    public sessionStarted(sessionId: string): UniversalEvent {
        this.sessionId = sessionId;
        return eventBuilder.sessionStarted(sessionId, Date.now());
    }

    public sessionEnded(
        reason: "completed" | "error" | "interrupted",
        stats?: TurnStats,
    ): UniversalEvent {
        return eventBuilder.sessionEnded(
            this.sessionId,
            Date.now(),
            reason,
            stats,
        );
    }

    public error(message: string, code?: string): UniversalEvent {
        return eventBuilder.error(this.sessionId, Date.now(), message, code);
    }

    public translate(event: AgentSessionEvent): UniversalEvent[] {
        return match(event)
            .with(
                { type: "message_start", message: { role: "assistant" } },
                () => this.startMessage(),
            )
            .with(
                {
                    type: "message_update",
                    assistantMessageEvent: { type: "text_delta" },
                },
                ({ assistantMessageEvent }) =>
                    this.messageDelta("text", assistantMessageEvent.delta),
            )
            .with(
                {
                    type: "message_update",
                    assistantMessageEvent: { type: "thinking_delta" },
                },
                ({ assistantMessageEvent }) =>
                    this.messageDelta("reasoning", assistantMessageEvent.delta),
            )
            .with(
                { type: "message_end", message: { role: "assistant" } },
                ({ message }) => this.completeMessage(message.content),
            )
            .with(
                { type: "tool_execution_start" },
                ({ toolCallId, toolName, args }) =>
                    this.startToolCall(toolCallId, toolName, args),
            )
            .with(
                { type: "tool_execution_end" },
                ({ toolCallId, toolName, result, isError }) =>
                    this.completeToolCall(
                        toolCallId,
                        toolName,
                        result,
                        isError,
                    ),
            )
            .otherwise(() => []);
    }

    private startMessage(): UniversalEvent[] {
        if (this.currentMessageItem) return [];

        this.currentMessageItem = eventBuilder.item(
            nextItemId(),
            "message",
            "assistant",
            "in_progress",
            [],
        );
        return [
            eventBuilder.itemStarted(
                this.sessionId,
                Date.now(),
                this.currentMessageItem,
            ),
        ];
    }

    private messageDelta(
        type: ContentDelta["type"],
        text: string,
    ): UniversalEvent[] {
        if (!this.currentMessageItem) return [];

        return [
            eventBuilder.itemDelta(
                this.sessionId,
                Date.now(),
                this.currentMessageItem.item_id,
                { type, text },
            ),
        ];
    }

    private completeMessage(
        content: Extract<
            Extract<AgentSessionEvent, { type: "message_end" }>["message"],
            { role: "assistant" }
        >["content"],
    ): UniversalEvent[] {
        const completedContent: ContentPart[] = [];
        for (const block of content) {
            const part = match(block)
                .with(
                    { type: "text" },
                    ({ text }) =>
                        ({ type: "text", text }) satisfies ContentPart,
                )
                .with(
                    { type: "thinking" },
                    ({ thinking }) =>
                        ({
                            type: "reasoning",
                            text: thinking,
                        }) satisfies ContentPart,
                )
                .otherwise(() => undefined);
            if (part) completedContent.push(part);
        }

        if (!this.currentMessageItem) return [];

        const completedItem: UniversalItem = {
            ...this.currentMessageItem,
            status: "completed",
            content: completedContent,
        };
        this.currentMessageItem = undefined;
        return [
            eventBuilder.itemCompleted(
                this.sessionId,
                Date.now(),
                completedItem,
            ),
        ];
    }

    private startToolCall(
        toolCallId: string,
        toolName: string,
        args: unknown,
    ): UniversalEvent[] {
        const item = eventBuilder.item(
            nextItemId(),
            "tool_call",
            "assistant",
            "in_progress",
            [
                {
                    type: "tool_call",
                    call_id: toolCallId,
                    name: toolName,
                    arguments: serialize(args),
                },
            ],
        );
        this.toolItems.set(toolCallId, item);
        return [eventBuilder.itemStarted(this.sessionId, Date.now(), item)];
    }

    private completeToolCall(
        toolCallId: string,
        toolName: string,
        result: unknown,
        isError: boolean,
    ): UniversalEvent[] {
        const events: UniversalEvent[] = [];
        let toolItem = this.toolItems.get(toolCallId);
        if (!toolItem) {
            const [startedEvent] = this.startToolCall(toolCallId, toolName, {});
            if (startedEvent) events.push(startedEvent);
            toolItem = this.toolItems.get(toolCallId);
        }
        if (!toolItem) return events;

        events.push(
            eventBuilder.itemCompleted(this.sessionId, Date.now(), {
                ...toolItem,
                status: "completed",
            }),
        );
        const resultItem = eventBuilder.item(
            nextItemId(),
            "tool_result",
            "tool",
            isError ? "failed" : "completed",
            [
                {
                    type: "tool_result",
                    call_id: toolCallId,
                    output: toolResultOutput(result),
                    is_error: isError,
                },
            ],
        );
        events.push(
            eventBuilder.itemCompleted(this.sessionId, Date.now(), resultItem),
        );
        this.toolItems.delete(toolCallId);
        return events;
    }
}

function nextItemId(): string {
    return `item_${randomUUID()}`;
}

function toolResultOutput(result: unknown): string {
    if (!isRecord(result) || !Array.isArray(result.content))
        return serialize(result);

    const output: string[] = [];
    for (const part of result.content) {
        if (
            isRecord(part) &&
            part.type === "text" &&
            typeof part.text === "string"
        ) {
            output.push(part.text);
            continue;
        }
        output.push(serialize(part));
    }
    return output.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function serialize(value: unknown): string {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}
