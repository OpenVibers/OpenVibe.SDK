/** AG-UI 1.0 event stream and agent.run@1 snapshot. */
export interface AgentSource { url: string; title: string; site: string }
export interface AgentUiEvent { type: string; timestamp: string; threadId?: string; runId?: string; metadata?: { ov?: { title?: string; kind?: string; sources?: AgentSource[]; attachments?: unknown[]; cost_usd?: number | null; needs_you?: object | null; product?: string; ref?: string | null } }; [field: string]: unknown }
export interface AgentRun { id: string; product: string; title: string; status: 'queued'|'running'|'waiting'|'needs_you'|'succeeded'|'failed'|'stopped'|'cancelled'; plan: Array<{title:string;status:string}>; steps: Array<Record<string, unknown>>; sources: AgentSource[]; result: Record<string, unknown>|null; started_at: string; ended_at: string|null; cost_usd: number|null }
export interface AgentApproval { id?: string; action?: string; [field: string]: unknown }
export interface AgentEvent { id: string|null; event: string|null; data: AgentUiEvent|null }
export interface AgentsClient { run(id: string, options?: {signal?: AbortSignal}): Promise<AgentRun|null>; events(id: string, options?: {lastEventId?: string|number; signal?: AbortSignal; maxReconnects?: number; reconnectDelayMs?: number}): AsyncIterable<AgentEvent>; post(id: string, approval: AgentApproval, options?: {signal?: AbortSignal}): Promise<unknown> }
export function createAgentsClient(client: unknown, options?: {baseUrl?: string; service?: string; audience?: string}): AgentsClient;
