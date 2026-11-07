/** openvibe-sdk/streams: the Agent Streams plan (S1) — an agent's own stream on OpenVibe.Live. */
type Opts = { signal?: AbortSignal };
/** Who may watch an agent stream. */
export type AgentStreamVisibility = 'private' | 'unlisted' | 'public';
/** Where the agent's task runs. */
export type AgentTaskSource = 'codes' | 'actor' | 'desk' | 'node';
/** Why the desk's privacy screen is up. */
export type CurtainReason = 'password_field' | 'secret_file' | 'env_print' | 'manual' | 'site' | 'detector';
export interface AgentTask {
    source: AgentTaskSource;
    ref: string;
    title: string;
    url?: string;
}
export interface AgentStream {
    id: string;
    owner: string;
    channel: string;
    title: string;
    task: AgentTask;
    visibility: AgentStreamVisibility;
    mode: 'watch' | 'narrated' | 'copilot' | 'chatplays';
    state: 'idle' | 'live' | 'ended';
    curtain: { up: boolean; since?: string | null };
    viewers: number;
    started_at: string | null;
    ended_at: string | null;
    worked_seconds: number;
    last_frame_url: string | null;
    vod_id: string | null;
    page_url: string;
    label: 'AI agent';
}
/** The publish part: where to publish, with the ticket that opens the door (shown once). */
export interface AgentStreamPublish { whip_url: string; ticket: string; expires_at: string }
/** What the desk polls: viewers, whether Live wants video, the privacy screen, when it ends. */
export interface AgentStreamState {
    viewers: number;
    encode: boolean;
    curtain: { up: boolean; since?: string | null; reason?: CurtainReason };
    ends_at: string | null;
}
export interface StartAgentStreamRequest {
    title: string;
    task: AgentTask;
    visibility: AgentStreamVisibility;
    allowSites?: string[];
}
export interface StreamsClient {
    /** Start an agent's stream → { stream, publish }. */
    startAgentStream(request: StartAgentStreamRequest, opts?: Opts): Promise<{ stream: AgentStream; publish: AgentStreamPublish }>;
    /** A new publish ticket for a stream that is still live. */
    renewTicket(id: string, opts?: Opts): Promise<AgentStreamPublish>;
    /** Revoke the publish ticket: the kill switch. */
    revokeTicket(id: string, opts?: Opts): Promise<Record<string, unknown>>;
    /** What the desk polls every ten seconds (with the publish ticket). */
    state(id: string, opts?: Opts & { ticket?: string }): Promise<AgentStreamState>;
    /** Raise or drop the desk's privacy screen. */
    setCurtain(id: string, up: boolean, reason: CurtainReason, opts?: Opts): Promise<Record<string, unknown>>;
    /** Send the last frame (JPEG or WebP, at most 200 KB). */
    postFrame(id: string, bytes: Uint8Array | ArrayBuffer, opts?: Opts & { ticket?: string; contentType?: 'image/jpeg' | 'image/webp' }): Promise<Record<string, unknown>>;
    /** Switch who may watch. */
    setVisibility(id: string, visibility: AgentStreamVisibility, opts?: Opts): Promise<Record<string, unknown>>;
    /** End the stream; the card stays. */
    end(id: string, opts?: Opts): Promise<Record<string, unknown>>;
    /** A view ticket for the player's join message (ten minutes). */
    viewTicket(id: string, opts?: Opts): Promise<{ ticket: string; expires_at: string }>;
    /** Schedule a public agent stream. */
    schedule(request: ScheduleRequest, opts?: Opts): Promise<{ schedule: AgentSchedule }>;
    /** The caller's own schedules, or a channel's public 24-hour window. */
    listSchedules(query?: { channel?: string; mine?: boolean }, opts?: Opts): Promise<{ schedules: AgentSchedule[] }>;
    /** Cancel a schedule that has not started. */
    cancelSchedule(id: string, opts?: Opts): Promise<{ schedule: AgentSchedule }>;
    /** Opt in to a schedule's reminder; the answer is the count. */
    remindSchedule(id: string, opts?: Opts): Promise<{ reminders: number; reminded: boolean }>;
    /** Post one step from any harness. */
    postStep(id: string, step: AgentStepInput, opts?: Opts & { ticket?: string }): Promise<{ step: AgentStep }>;
    /** steps.post() — the same. */
    steps: { post(id: string, step: AgentStepInput, opts?: Opts & { ticket?: string }): Promise<{ step: AgentStep }> };
    /** The Co-pilot digest (a service token with chat.agent_digest.read). */
    digest: { read(id: string, opts?: Opts & { since?: string }): Promise<Record<string, unknown>> };
    /** A poll the Co-pilot asks the room to run (chat.agent_poll.write). */
    poll: {
        open(id: string, poll: { question: string; options: string[]; seconds?: number }, opts?: Opts): Promise<Record<string, unknown>>;
        result(id: string, opts?: Opts): Promise<Record<string, unknown>>;
    };
    /** Poll the control log; call handler for each new control. Returns a stop function. */
    onControl(id: string, handler: (control: AgentControl) => void, opts?: Opts & { intervalMs?: number }): () => void;
}
export type AgentStreamMode = 'watch' | 'narrated' | 'copilot' | 'chatplays';
export interface ScheduleRequest {
    title: string;
    task: AgentTask;
    mode?: AgentStreamMode;
    visibility?: AgentStreamVisibility;
    startsAt: string | Date;
}
export interface AgentSchedule {
    id: string;
    owner: string;
    channel: string;
    title: string;
    task: AgentTask;
    mode: AgentStreamMode;
    visibility: AgentStreamVisibility;
    starts_at: string;
    state: 'scheduled' | 'live' | 'ended' | 'missed' | 'cancelled';
    agent_stream_id: string | null;
    missed_reason: 'desk_offline' | 'task_not_ready' | 'waits_for_go' | null;
    waits_for_go: boolean;
    started_at: string | null;
    ended_at: string | null;
    reminders: number;
    reminded?: boolean;
    page_url: string;
    created_at: string;
}
export interface AgentStepInput {
    title: string;
    status: 'started' | 'passed' | 'failed' | 'skipped';
    detail?: string;
    at?: string | Date;
    tests?: { passed: number; failed: number };
    cost_usd?: number;
}
export interface AgentStep {
    id: number;
    at: string;
    title: string;
    status: 'started' | 'passed' | 'failed' | 'skipped';
    detail?: string;
    tests?: { passed: number; failed: number };
    cost_usd?: number;
}
export interface AgentControl {
    control: 'pause' | 'curtain' | 'mute' | 'end';
    by: { handle: string; role: 'owner' | 'moderator' };
    at: string;
    stream: string;
    paused_by?: string | null;
}
export function createStreamsClient(client: { json(opts: Record<string, unknown>): Promise<any>; request(opts: Record<string, unknown>): Promise<any>; origin(service: string): Promise<string> }, options?: { baseUrl?: string }): StreamsClient;
