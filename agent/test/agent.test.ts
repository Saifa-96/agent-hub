import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

const createAgentSession = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", () => ({
    createAgentSession,
}));

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
});

test("requires a workspace directory", async () => {
    vi.stubEnv("WORKSPACE_DIR", "");
    const { chat } = await import("../src/agent");

    await expect(
        chat({
            sessionId: "session-1",
            userMessage: "Hello",
            callbacks: { onMessage: vi.fn() },
        }),
    ).rejects.toThrow("WORKSPACE_DIR is required");
    expect(createAgentSession).not.toHaveBeenCalled();
});

test("creates a session and forwards its events", async () => {
    vi.stubEnv("WORKSPACE_DIR", "/workspace");
    const event = { type: "agent_settled" } satisfies AgentSessionEvent;
    let listener = (_event: AgentSessionEvent): void => undefined;
    const subscribe = vi.fn(
        (nextListener: (event: AgentSessionEvent) => void) => {
            listener = nextListener;
            return vi.fn();
        },
    );
    const prompt = vi.fn(async () => listener(event));
    createAgentSession.mockResolvedValue({ session: { prompt, subscribe } });
    const onMessage = vi.fn();
    const { chat } = await import("../src/agent");

    const result = await chat({
        sessionId: "session-1",
        userMessage: "Hello",
        callbacks: { onMessage },
    });

    expect(createAgentSession).toHaveBeenCalledWith({ cwd: "/workspace" });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("Hello");
    expect(onMessage).toHaveBeenCalledWith(event);
    expect(result).toEqual({ sessionId: "session-1" });
});

test("propagates prompt failures", async () => {
    vi.stubEnv("WORKSPACE_DIR", "/workspace");
    const prompt = vi.fn().mockRejectedValue(new Error("Prompt failed"));
    const subscribe = vi.fn(() => vi.fn());
    createAgentSession.mockResolvedValue({ session: { prompt, subscribe } });
    const { chat } = await import("../src/agent");

    await expect(
        chat({
            sessionId: "session-1",
            userMessage: "Hello",
            callbacks: { onMessage: vi.fn() },
        }),
    ).rejects.toThrow("Prompt failed");
});
