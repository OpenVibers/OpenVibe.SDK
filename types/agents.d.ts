/** One agent system: agents.run@1, agents.step@1, agents.approval@1, the AG-UI stream and the plugin interfaces. */

// ── The run shape (openvibe-contracts agents.run@1) ─────────────────────────
export type AgentRunStatus = 'planning' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
export type AgentsStepKind = 'think' | 'tool' | 'message' | 'approval' | 'child' | 'file';
export interface AgentsOwner { type: string; id: string; revision?: number }
/** The agent that runs it, with its face: a glyph from the registry, a hue, a picture, and the loop (harness) that runs it. */
export interface AgentsAgentRef { id: string; name?: string; product?: string; glyph?: string; hue?: number; avatar_url?: string; harness?: string }
export type AgentsRunKind = 'chat' | 'ask' | 'task' | 'code' | 'machine' | 'goal' | (string & {});
export interface AgentsModel { id: string; source?: 'openvibe' | 'keys' | 'machines' | 'plans'; machine?: string; name?: string; effort?: string }
export interface AgentsWhere { kind: 'openvibe' | 'machine' | 'runner' | 'this-computer'; id?: string; name?: string }
export type AgentsTarget = 'new' | 'openvibe' | { repo: string; branch?: string };
export interface AgentsContext { site?: string; url?: string; title?: string; kind?: string; id?: string }
export interface AgentsAttachment { kind: 'image' | 'file' | 'audio' | 'video'; media_id?: string; url?: string; name?: string; mime?: string; bytes?: number; width?: number; height?: number; alt?: string }
export interface AgentsOutput { kind: 'link' | 'file' | 'image' | 'video' | 'audio' | 'pr' | 'repo' | 'page' | 'post' | 'run'; title: string; url?: string; thumb?: string; media_id?: string; state?: string }
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
    // 1.1.0 (Contracts 0.414.0), all optional:
    title?: string;
    kind?: AgentsRunKind;
    /** Its address on the Frame: `<product>:<id>`. */
    ref?: string;
    url?: string;
    model?: AgentsModel;
    where?: AgentsWhere;
    target?: AgentsTarget;
    doing?: { text: string; glyph?: string } | null;
    /** Why a waiting run waits; `message` is a conversation between turns. */
    waiting?: { for: 'message' | 'approval' | 'takeover' | 'payment'; what?: string; approval?: string; since?: string } | null;
    preview?: { text: string; from?: 'person' | 'agent' | 'system' | 'tool'; at?: string } | null;
    context?: AgentsContext;
    outputs?: AgentsOutput[];
    counts?: { steps?: number; children?: number; files?: number; approvals?: number; unread?: number };
    visibility?: 'private' | 'shared' | 'public';
    ended_at?: string | null;
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
    // 1.1.0 (Contracts 0.414.0), all optional:
    from?: 'person' | 'agent' | 'system' | 'tool';
    author?: { id?: string; name: string; avatar_url?: string };
    status?: 'running' | 'done' | 'failed';
    title?: string;
    glyph?: string;
    attachments?: AgentsAttachment[];
    sources?: Array<{ n: number; title?: string; url: string; site?: string }>;
    /** A rich card; a reader that does not know the type shows `text`. */
    ui?: { type: string; data?: Record<string, unknown> };
    desk?: { id: string; still_url?: string; action?: { type: string; x?: number; y?: number; text?: string } };
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

// ── The client ──────────────────────────────────────────────────────────────
/** agents.run-start@1: only `text` is required. */
export interface AgentsRunStart {
    text: string;
    title?: string;
    kind?: AgentsRunKind;
    agent?: string;
    model?: AgentsModel;
    where?: AgentsWhere;
    target?: AgentsTarget;
    context?: AgentsContext;
    attachments?: AgentsAttachment[];
    sources?: Array<'web' | 'openvibe' | 'mine' | 'page'>;
    depth?: 'quick' | 'balanced' | 'deep';
    parent_run?: string;
    budget?: AgentsBudget;
}
/** agents.event@1: one event of a run's stream. */
export interface AgentsStreamEvent {
    type: 'run' | 'step' | 'delta' | 'approval' | 'end';
    run?: AgentsRun; step?: AgentsStep; approval?: AgentsApproval;
    run_id?: string; seq?: number; text?: string; status?: 'done' | 'failed' | 'stopped';
}
export type AgentsRunLike = string | Pick<AgentsRun, 'id'> & { ref?: string };
export interface AgentsListOptions { kind?: AgentsRunKind; status?: AgentRunStatus; q?: string; limit?: number; cursor?: string; before?: string; agent?: string; parentRun?: string; signal?: AbortSignal }
export interface AgentsStepsOptions { after?: number; limit?: number; signal?: AbortSignal }
export interface AgentsEventsOptions { after?: number; lastEventId?: string | number; signal?: AbortSignal; maxReconnects?: number; reconnectDelayMs?: number }
export interface AgentsFollowHandlers extends AgentsEventsOptions {
    onRun?(run: AgentsRun): unknown;
    onStep?(step: AgentsStep): unknown;
    onDelta?(delta: { run_id?: string; seq?: number; text?: string }): unknown;
    onApproval?(approval: AgentsApproval): unknown;
    onEvent?(event: AgentEvent): unknown;
}

export interface AgentsRuns {
    list(options?: AgentsListOptions): Promise<AgentsRunList>;
    /** One run; null on 404. */
    get(run: AgentsRunLike, options?: { signal?: AbortSignal }): Promise<AgentsRun | null>;
    steps(run: AgentsRunLike, options?: AgentsStepsOptions): Promise<AgentsStepPage>;
    /** Start a run: the words, or the whole agents.run-start@1 object. */
    start(request: string | AgentsRunStart, options?: { signal?: AbortSignal; idempotencyKey?: string }): Promise<AgentsRun>;
    /** Say something to a run: continue a conversation or steer work under way. */
    say(run: AgentsRunLike, message: string | { text?: string; attachments?: AgentsAttachment[] }, options?: { signal?: AbortSignal; idempotencyKey?: string }): Promise<AgentsStep>;
    stop(run: AgentsRunLike, options?: { reason?: string; signal?: AbortSignal }): Promise<AgentsRun>;
    events(run: AgentsRunLike, options?: AgentsEventsOptions): AsyncIterable<AgentEvent>;
    /** Follow a run until it ends; resolves with its end status (null when the stream closed without one). */
    follow(run: AgentsRunLike, handlers?: AgentsFollowHandlers): Promise<{ status: 'done' | 'failed' | 'stopped' | null }>;
}
export interface AgentsApprovals {
    /** Answer an approval by its id, its object, or the seq of the step that asked. */
    answer(run: AgentsRunLike, approval: string | number | Pick<AgentsApproval, 'id' | 'step_seq'>, answer: string | Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AgentsApproval>;
}
export interface AgentsDeskView { desk: { id: string; [field: string]: unknown }; view: unknown; still: string | null }
export interface AgentsClient {
    runs: AgentsRuns;
    approvals: AgentsApprovals;
    /** See it work: the desks a run may show, the person's control of one, the finished run's replay. */
    desks(run: AgentsRunLike, options?: { signal?: AbortSignal }): Promise<{ desks: AgentsDeskView[] }>;
    takeOver(run: AgentsRunLike, desk: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    handBack(run: AgentsRunLike, desk: string, note?: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    replay(run: AgentsRunLike, options?: { signal?: AbortSignal }): Promise<{ steps: object[] }>;
    /** The first shapes, as released: an Ask run's snapshot, its approval post and its stream. */
    run(id: string, options?: { signal?: AbortSignal }): Promise<AgentsRun | null>;
    post(id: string, approval: AgentApproval, options?: { signal?: AbortSignal }): Promise<unknown>;
    events(run: AgentsRunLike, options?: AgentsEventsOptions): AsyncIterable<AgentEvent>;
}
export interface AgentsClientOptions { baseUrl?: string; service?: string; audience?: string; /** `/api/v1` on a product (default), `/api/frame` on the Frame. */ prefix?: string }
export function createAgentsClient(client: unknown, options?: AgentsClientOptions): AgentsClient;
/** Every product's runs through the Frame (`/api/frame/runs…`): a run is named by its ref. */
export function createFrameAgentsClient(client: unknown, options?: Omit<AgentsClientOptions, 'prefix' | 'service' | 'audience'>): AgentsClient;
export const KINDS: readonly ['chat', 'ask', 'task', 'code', 'machine', 'goal'];
export const STATUSES: readonly AgentRunStatus[];
export const END_STATUSES: readonly ['done', 'failed', 'stopped'];
export function isEnd(runOrStatus: AgentsRun | AgentRunStatus | null | undefined): boolean;
export function refOf(product: string, id: string): string;
export function parseRef(ref: string): { product: string; id: string } | null;
/** Does this run need its person now (an approval, a takeover, a payment)? A conversation between turns does not. */
export function needsPerson(run: AgentsRun | null | undefined): boolean;

// ── The plugin interfaces (types only; the loop that calls them is the next release) ─────────
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
