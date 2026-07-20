import {
    type AgentSessionEvent,
    AuthStorage,
    createAgentSession,
    ModelRegistry,
} from "@earendil-works/pi-coding-agent";

const MODEL_PROVIDER = "deepseek";
const WORKSPACE_DIR =
    process.env.NODE_ENV === "production" ? "/workspace" : "./workspace";
export const MODEL_ID = "deepseek-v4-flash";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.inMemory(authStorage);

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
    const model = modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
    if (!model) throw new Error(`Unknown model: ${MODEL_PROVIDER}/${MODEL_ID}`);

    const { session } = await createAgentSession({
        authStorage,
        cwd: WORKSPACE_DIR,
        model,
        modelRegistry,
    });
    session.subscribe((event) => params.callbacks.onMessage(event));
    await session.prompt(params.userMessage);
    return { sessionId: params.sessionId };
};
