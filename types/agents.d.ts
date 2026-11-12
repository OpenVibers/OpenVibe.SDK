/** One agent system: agents.run@1, agents.step@1, agents.approval@1, the AG-UI stream and the plugin interfaces. */

// ── The run shape (openvibe-contracts agents.run@1) ─────────────────────────
export type AgentRunStatus = 'planning' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
export type AgentsStepKind = 'think' | 'tool' | 'message' | 'approval' | 'child' | 'file';
export interface AgentsOwner { type: string; id: string; revision?: number }
export interface AgentsAgentRef { id: string; name?: string; product?: string }
export interface AgentsBudget { usd?: number; tokens?: number; seconds?: number; steps?: number }
export interface AgentsCost { usd?: number; tokens?: number; seconds?: number; steps?: number }
export interface AgentsRun {
    id: string;
    owner: AgentsOwner;
    agent: AgentsAgentRef;
    parent_run?: string | null;
    budget?: AgentsBudget;
    status: AgentRunStatus;
    created_at: string;
    updated_at: string;
    result_summary?: string | null;
    cost?: AgentsCost | null;
}
export interface AgentsRunList { runs: AgentsRun[]; next?: string | null }

// ── The step shape (agents.step@1) ─────────────────────────────────────────
export interface AgentsToolCall { name: string; input?: unknown }
export interface AgentsStep {
    run_id: string;
    seq: number;
    kind: AgentsStepKind;
    text?: string | null;
    tool_call?: AgentsToolCall | null;
    result?: unknown;
    cost?: { usd?: number; tokens?: number; seconds?: number } | null;
    started_at: string;
    ended_at?: string | null;
    child_run?: string | null;
}
export interface AgentsStepPage { steps: AgentsStep[]; next?: number | null }

// ── The approval shape (agents.approval@1) ─────────────────────────────────
export interface AgentsApprovalOption { id: string; label: string }
export interface AgentsApproval {
    id?: string;
    run_id: string;
    step_seq: number;
    what: string;
    options: AgentsApprovalOption[];
    decided_by?: AgentsOwner | null;
    decided_at?: string | null;
    answer?: string | null;
}

// ── The legacy AG-UI run (Network's composer Ask) ──────────────────────────
export interface AgentSource { url: string; title: string; site: string }
export interface AgentUiEvent {
    type: string;
    timestamp: string;
    threadId?: string;
    runId?: string;
    metadata?: { ov?: { title?: string; kind?: string; sources?: AgentSource[]; attachments?: unknown[]; cost_usd?: number | null; needs_you?: object | null; product?: string; ref?: string | null } };
    [field: string]: unknown;
}
/** Network's AG-UI ask run (agent.run@1, the composer's Ask). Different from AgentsRun. */
export interface AgentRun {
    id: string;
    product: string;
    title: string;
    status: 'queued' | 'running' | 'waiting' | 'needs_you' | 'succeeded' | 'failed' | 'stopped' | 'cancelled';
    plan: Array<{ title: string; status: string }>;
    steps: Array<Record<string, unknown>>;
    sources: AgentSource[];
    result: Record<string, unknown> | null;
    started_at: string;
    ended_at: string | null;
    cost_usd: number | null;
}
export interface AgentApproval { id?: string; action?: string; [field: string]: unknown }
export interface AgentEvent { id: string | null; event: string | null; data: AgentUiEvent | null }

// ── The client ─────────────────────────────────────────────────────────────
export interface AgentsRunStartOptions {
    budget?: AgentsBudget;
    parentRun?: string | null;
    signal?: AbortSignal;
    idempotencyKey?: string;
}
export interface AgentsListOptions { limit?: number; before?: string; status?: AgentRunStatus; agent?: string; parentRun?: string; signal?: AbortSignal }
export interface AgentsStepsOptions { after?: number; limit?: number; signal?: AbortSignal }
export interface AgentsEventsOptions { lastEventId?: string | number; signal?: AbortSignal; maxReconnects?: number; reconnectDelayMs?: number }

export interface AgentsRuns {
    list(options?: AgentsListOptions): Promise<AgentsRunList>;
    get(run: string | AgentsRun, options?: { signal?: AbortSignal }): Promise<AgentsRun | null>;
    steps(run: string | AgentsRun, options?: AgentsStepsOptions): Promise<AgentsStepPage>;
    start(agent: string | AgentsAgentRef, input: unknown, options?: AgentsRunStartOptions): Promise<AgentsRun>;
    stop(run: string | AgentsRun, options?: { reason?: string; signal?: AbortSignal }): Promise<AgentsRun>;
}
export interface AgentsApprovals {
    answer(run: string | AgentsRun, stepSeq: number, answer: string | Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AgentsApproval>;
}
export interface AgentsClient {
    /** The snapshot of one run (null on 404). */
    run(id: string, options?: { signal?: AbortSignal }): Promise<AgentsRun | null>;
    /** The AG-UI/SSE stream of a run; Last-Event-ID resumes after a reconnect. */
    events(run: string | AgentsRun, options?: AgentsEventsOptions): AsyncIterable<AgentEvent>;
    /** The older approval post (POST /api/v1/runs/:id/approvals). */
    post(id: string, approval: AgentApproval, options?: { signal?: AbortSignal }): Promise<unknown>;
    runs: AgentsRuns;
    approvals: AgentsApprovals;
}
export function createAgentsClient(client: unknown, options?: { baseUrl?: string; service?: string; audience?: string }): AgentsClient;

// ── The plugin interfaces (types only; no runtime in this release) ─────────
export interface AgentsModelRequest { messages: object[]; tools?: AgentTool[]; model?: string; budget?: AgentsBudget; signal?: AbortSignal }
export interface AgentsModelTurn { text?: string; tool_calls?: object[]; usage?: { tokens?: number }; cost?: { usd?: number }; raw?: object }
/** The only way the loop reaches a model: AI routes, a person's key, a Link machine's local model or a plan. */
export interface AgentModelAdapter {
    id: string;
    family?: string;
    complete(request: AgentsModelRequest): Promise<AgentsModelTurn>;
}

export interface AgentToolContext { run: AgentsRun; toolCall: AgentsToolCall; signal?: AbortSignal }
export interface AgentToolResult { result: unknown; cost?: { usd?: number }; artifacts?: object[] }
/** A tool the loop may call: an OpenVibe product, an MCP server or one of a machine's own tools. */
export interface AgentTool {
    name: string;
    description: string;
    inputSchema?: object;
    run(input: object, context: AgentToolContext): Promise<AgentToolResult>;
}

export interface AgentSandboxOptions { cwd?: string; env?: object; timeoutMs?: number; signal?: AbortSignal }
/** Where code runs: a Codes worker, a Link machine or an OpenVibe computer. */
export interface AgentSandbox {
    id: string;
    where?: 'codes-worker' | 'link-machine' | 'run-computer' | 'this-computer';
    exec(command: string | string[], options?: AgentSandboxOptions): Promise<{ ok: boolean; output: string; exitCode?: number; artifacts?: object[] }>;
    readFile?(path: string, options?: { encoding?: string }): Promise<string | Uint8Array>;
    writeFile?(path: string, data: string | Uint8Array): Promise<{ path: string; bytes?: number }>;
}

export interface AgentMemoryQuery { text?: string; kinds?: string[]; limit?: number }
export interface AgentMemoryEntry { text: string; kind?: string; ref?: string; data?: object }
/** What a run may remember, scoped to its owner (Actor's memories, Codes' knowledge, a person's notes). */
export interface AgentMemory {
    read(query: AgentMemoryQuery): Promise<object[]>;
    write(entry: AgentMemoryEntry): Promise<object>;
    forget?(id: string): Promise<boolean>;
}

export interface AgentsPlanStep { title: string; kind?: string; tool?: string }
/** Turns the input into steps before the loop runs; replaceable, including with a no-plan adapter. */
export interface AgentPlanner {
    plan(input: { run: AgentsRun; text: string; context?: object; signal?: AbortSignal }): Promise<{ steps: AgentsPlanStep[]; text?: string }>;
}

export interface AgentsReview { ok: boolean; reason?: string; by?: string; cross?: boolean }
/** The second look: a model of another family, a test suite or a rubric. */
export interface AgentReviewer {
    review(input: { run: AgentsRun; result: unknown; steps?: AgentsStep[]; signal?: AbortSignal }): Promise<AgentsReview>;
}
