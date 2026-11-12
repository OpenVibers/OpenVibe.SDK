// openvibe-sdk/agents/loop: the light agent loop (a port of pi's agent loop, MIT, (c) 2025 Mario Zechner).

export type LoopRole = 'system' | 'user' | 'assistant' | 'tool';
export interface LoopToolCall { id: string; name: string; input: Record<string, unknown>; }
export interface LoopMessage {
    role: LoopRole;
    text?: string;
    thinking?: string;
    tool_calls?: LoopToolCall[];
    tool_call_id?: string;
    name?: string;
    result?: unknown;
    is_error?: boolean;
    memo?: boolean;
    duration_ms?: number;
    artifacts?: unknown[];
    stop?: 'stop' | 'tool_use' | 'length' | 'error' | 'aborted';
    usage?: { tokens?: number } | null;
    cost?: { usd?: number } | null;
    error?: string;
    /** Kept in the thread, never sent to the model (a card, a note for the UI). */
    ui_only?: boolean;
    at?: number;
}
export interface LoopModelTurn {
    text?: string;
    thinking?: string;
    tool_calls?: Array<{ id?: string; name: string; input?: Record<string, unknown> }>;
    stop?: 'stop' | 'tool_use' | 'length' | 'error' | 'aborted';
    usage?: { tokens?: number };
    cost?: { usd?: number };
    error?: string;
}
export interface LoopModelAdapter {
    id?: string;
    family?: string;
    complete(request: {
        messages: LoopMessage[];
        tools: LoopTool[];
        system?: string;
        signal?: AbortSignal;
        budgetLeft: { usd?: number; tokens?: number; turns?: number } | null;
        onDelta(delta: { text?: string; thinking?: string }): void | Promise<void>;
    }): Promise<LoopModelTurn>;
}
export interface LoopToolResult { result?: unknown; is_error?: boolean; terminate?: boolean; cost?: { usd?: number }; artifacts?: unknown[]; }
export interface LoopTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    run(input: Record<string, unknown>, context: { toolCall: LoopToolCall; signal: AbortSignal; run: unknown; onUpdate(partial: unknown): void }): Promise<LoopToolResult | unknown> | LoopToolResult | unknown;
    sequential?: boolean;
    idempotent?: boolean;
    timeoutMs?: number;
    title?: string;
    glyph?: string;
    prepareInput?(input: Record<string, unknown>): Record<string, unknown>;
}
export type LoopEvent =
    | { type: 'agent_start' }
    | { type: 'turn_start' }
    | { type: 'message_start' | 'message_end'; message: LoopMessage }
    | { type: 'message_update'; message: LoopMessage; delta: { text?: string; thinking?: string } }
    | { type: 'tool_start'; toolCall: LoopToolCall }
    | { type: 'tool_update'; toolCall: LoopToolCall; partial: unknown }
    | { type: 'tool_end'; toolCall: LoopToolCall; result: unknown; isError: boolean; durationMs?: number }
    | { type: 'turn_end'; message: LoopMessage; toolResults: LoopMessage[] }
    | { type: 'agent_end'; messages: LoopMessage[]; stop: LoopStop; error: string | null };
export type LoopStop = 'done' | 'terminated' | 'budget' | 'turns' | 'aborted' | 'error';
export interface LoopOptions {
    model: LoopModelAdapter;
    tools?: LoopTool[];
    system?: string;
    messages?: LoopMessage[];
    prompts?: LoopMessage[];
    budget?: { usd?: number; tokens?: number; turns?: number; steps?: number };
    beforeToolCall?(call: { toolCall: LoopToolCall; input: Record<string, unknown>; tool: LoopTool; assistant: LoopMessage; messages: LoopMessage[] }, signal?: AbortSignal): Promise<{ block?: boolean; reason?: string; terminate?: boolean } | void> | { block?: boolean; reason?: string; terminate?: boolean } | void;
    afterToolCall?(call: { toolCall: LoopToolCall; input: Record<string, unknown>; tool: LoopTool; assistant: LoopMessage; result: unknown; isError: boolean; messages: LoopMessage[] }, signal?: AbortSignal): Promise<{ result?: unknown; isError?: boolean; terminate?: boolean } | void> | { result?: unknown; isError?: boolean; terminate?: boolean } | void;
    transformContext?(messages: LoopMessage[], signal?: AbortSignal): Promise<LoopMessage[]> | LoopMessage[];
    steering?(): Promise<LoopMessage[]> | LoopMessage[];
    followUp?(): Promise<LoopMessage[]> | LoopMessage[];
    finishTurn?(turn: { assistant: LoopMessage; results: LoopMessage[]; messages: LoopMessage[]; added: LoopMessage[]; totals: { tokens: number; usd: number; turns: number; toolCalls: number } }): Promise<{ action?: 'end' | 'continue' } | void> | { action?: 'end' | 'continue' } | void;
    onEvent?(event: LoopEvent): void | Promise<void>;
    signal?: AbortSignal;
    toolExecution?: 'parallel' | 'sequential';
    maxTurns?: number;
    repeatLimit?: number;
    toolTimeoutMs?: number;
    toolOutputLimit?: number;
    run?: unknown;
}
export interface LoopResult { messages: LoopMessage[]; stop: LoopStop; error: string | null; usage: { tokens: number }; cost: { usd: number }; turns: number; toolCalls: number; }
export function runLoop(options: LoopOptions): Promise<LoopResult>;
export interface StepSinkOptions {
    append(step: Record<string, unknown>): unknown;
    update?(seq: number, patch: Record<string, unknown>): unknown;
    delta?(seq: number, text: string): unknown;
    runId?: string | null;
    startSeq?: number;
    startTurn?: number;
    toolTitle?(call: LoopToolCall): string | undefined;
}
export function createStepSink(options: StepSinkOptions): (event: LoopEvent) => Promise<void>;
export function checkInput(schema: Record<string, unknown> | undefined, value: unknown, at?: string): string | null;
export const STOPS: LoopStop[];
export const DEFAULTS: { maxTurns: number; repeatLimit: number; toolTimeoutMs: number; toolOutputLimit: number };
