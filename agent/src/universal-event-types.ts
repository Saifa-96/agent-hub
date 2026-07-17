export interface ContentDelta {
    type: "text" | "reasoning";
    text: string;
}

export interface ContentPart {
    type:
        | "text"
        | "tool_call"
        | "tool_result"
        | "reasoning"
        | "status"
        | "image";
    text?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    output?: string;
    is_error?: boolean;
    label?: string;
    detail?: string;
    data?: string;
    media_type?: string;
}

export interface UniversalItem {
    item_id: string;
    kind: "message" | "tool_call" | "tool_result" | "status";
    role: "user" | "assistant" | "tool" | null;
    status: "in_progress" | "completed" | "failed";
    content: ContentPart[];
}

export interface TurnStats {
    costUsd: number;
    durationMs: number;
    numTurns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextTokens: number;
    contextWindow: number;
}

export interface UniversalEvent {
    type: string;
    timestamp: number;
    session_id?: string;
    reason?: "completed" | "error" | "interrupted";
    stats?: TurnStats;
    item?: UniversalItem;
    item_id?: string;
    delta?: ContentDelta;
    message?: string;
    code?: string;
}
