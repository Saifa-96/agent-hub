import {
    type AgentSessionEvent,
    createAgentSession,
} from "@earendil-works/pi-coding-agent";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR;

export interface StreamCallbacks {
    onMessage: (message: AgentSessionEvent) => void | Promise<void>;
}

export interface ChatParams {
    sessionId: string;
    userMessage: string;
    callbacks: StreamCallbacks;
}

export interface ChatResult {
    sessionId: string;
}

export const chat = async (params: ChatParams): Promise<ChatResult> => {
    if (!WORKSPACE_DIR) throw new Error("WORKSPACE_DIR is required");

    const { session } = await createAgentSession({ cwd: WORKSPACE_DIR });
    session.subscribe((event) => params.callbacks.onMessage(event));
    await session.prompt(params.userMessage);
    return { sessionId: params.sessionId };
};
