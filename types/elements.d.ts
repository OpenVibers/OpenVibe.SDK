import type { SubjectRef } from './core';

export type ElementSharing = 'private' | 'link' | 'gallery';
export type ElementRole = 'everyone' | 'follower' | 'subscriber' | 'vip' | 'operator' | 'owner';
export type ElementShape = 'round' | 'pill' | 'square';

export type ActionKind =
    | 'robot.drive_pulse' | 'robot.head_preset' | 'robot.headlight' | 'robot.say' | 'robot.macro'
    | 'chat.message' | 'chat.pin' | 'chat.poll'
    | 'screen.alert' | 'screen.animation' | 'screen.confetti' | 'screen.sound' | 'screen.tts'
    | 'screen.counter' | 'screen.state' | 'screen.visibility' | 'screen.scene'
    | 'stream.clip' | 'stream.moment' | 'stream.title' | 'stream.category'
    | 'ai.ask' | 'actor.task' | 'webhook.call' | 'money.tip_goal';

export type ProductId = 'bot' | 'chat' | 'live' | 'ai' | 'actor' | 'billing';

export type TriggerKind =
    | 'press' | 'hold' | 'double_press' | 'key' | 'gamepad' | 'chat_command' | 'chat_text'
    | 'follow' | 'tip' | 'ai_moment' | 'rundown_topic' | 'timer' | 'schedule'
    | 'robot_telemetry' | 'robot_event' | 'stream_start' | 'stream_end' | 'viewer_count' | 'element_event';

export type ElementValue = boolean | number | string | Array<number | string>;
export type ElementValues = Record<string, ElementValue>;

export interface ElementsError {
    /** Where the problem is, e.g. "/recipe/actions/0/product". */
    path: string;
    /** A plain sentence an editor can show after "Can't do that: ". */
    message: string;
}

export interface ElementValidation {
    valid: boolean;
    errors: ElementsError[];
}

/** One trigger declaration, or the fired occurrence shaped like it. */
export interface UiTrigger {
    kind: TriggerKind;
    [key: string]: unknown;
}

/** One action from the catalog, with the product that authorises it. */
export interface UiAction {
    kind: ActionKind;
    product: ProductId;
    [key: string]: unknown;
}

export interface ElementConditions {
    role?: ElementRole;
    /** Channel points only; stage 1 never charges money or Vibes. */
    cost?: { points: number };
    cooldown?: { per_person_seconds?: number; overall_seconds?: number };
    daily_cap?: { per_person?: number; overall?: number };
    live_only?: boolean;
    robot_turn_only?: boolean;
    chance?: { one_in: number };
}

export interface ElementLook {
    component: string;
    label: string;
    icon?: string;
    props?: Record<string, boolean | number | string>;
    style?: {
        tint?: string;
        shape?: ElementShape;
        opacity?: number;
        show_label?: boolean;
    };
}

export interface ElementRecipe {
    triggers: UiTrigger[];
    conditions?: ElementConditions;
    actions: UiAction[];
}

export interface ElementModReference {
    id: string;
    version: string;
    sha256: string;
    capabilities?: ActionKind[];
}

export interface UiElement {
    id?: string;
    revision?: number;
    name: string;
    description?: string;
    author: { name: string; subject?: SubjectRef };
    sharing: ElementSharing;
    look: ElementLook;
    recipe: ElementRecipe;
    capabilities: ActionKind[];
    initial_state?: ElementValues;
    mod?: ElementModReference;
    created_at?: string;
    updated_at?: string;
}

export interface ElementState {
    values?: ElementValues;
    revision?: number;
}

export interface ElementLimits {
    /** Milliseconds until this scope is ready; 0 when it is ready now. */
    cooldown(query: { scope: 'person' | 'overall'; elementId: string; actorId: string; at: number }): number | Promise<number>;
    /** How many times this scope already fired in the UTC day. */
    dailyCount(query: { scope: 'person' | 'overall'; elementId: string; actorId: string; day: string }): number | Promise<number>;
    /** Record an accepted fire so the cooldown and daily counters move. */
    hit(query: { elementId: string; actorId: string; at: number; day: string }): void | Promise<void>;
}

export interface ElementSpend {
    points: number;
    elementId: string;
    actorId: string;
    subject: SubjectRef | null;
    at: number;
}

export interface ElementSpendResult {
    ok: boolean;
    reason?: string;
    message?: string;
}

export interface ElementSendInfo {
    element: { id?: string; name?: string; capabilities: ActionKind[] };
    actor: { subject?: SubjectRef; role?: ElementRole; name?: string };
    trigger: UiTrigger;
    /** The product that authorises this action; the host dispatches on it. */
    product: ProductId;
}

export interface ElementSendResult {
    ok: boolean;
    result?: unknown;
    reason?: string;
    message?: string;
}

/** The host's side of run(). It is supplied by the product that owns the press. */
export interface ElementsHostContext {
    now?: number;
    random?: () => number;
    isLive?: boolean;
    robotInTurn?: boolean;
    element: { id?: string; name?: string; capabilities: ActionKind[] };
    actor?: { subject?: SubjectRef; role?: ElementRole; name?: string };
    limits?: ElementLimits;
    spend?: (query: ElementSpend) => ElementSpendResult | Promise<ElementSpendResult>;
    refund?: (query: ElementSpend) => void | Promise<void>;
    send: (action: UiAction, info: ElementSendInfo) => ElementSendResult | Promise<ElementSendResult>;
}

export type ElementsRefusalCode =
    | 'invalid' | 'trigger' | 'capability' | 'role' | 'not_live' | 'robot_turn' | 'chance'
    | 'cooldown' | 'daily_cap' | 'points' | 'limits' | 'action';

export interface ElementsRunSuccess {
    ok: true;
    pointsSpent: number;
    actions: Array<{ action: UiAction; result: unknown }>;
}

export interface ElementsRunRefusal {
    ok: false;
    code: ElementsRefusalCode;
    message: string;
    retryAfterMs?: number;
    scope?: 'person' | 'overall';
    refusedAction?: ActionKind;
    refunded?: boolean;
    pointsSpent?: number;
    actions?: Array<{ action: UiAction; result: unknown }>;
}

export type ElementsRunResult = ElementsRunSuccess | ElementsRunRefusal;

export interface ElementsReduceResult {
    values: ElementValues;
    revision: number;
    changed: boolean;
    errors: ElementsError[];
}

export declare function validate(element: unknown): ElementValidation;
export declare function run(recipe: ElementRecipe, trigger: UiTrigger, ctx: ElementsHostContext): Promise<ElementsRunResult>;
export declare function reduce(state: ElementState | null, actions: UiAction[], options?: { maxKeys?: number }): ElementsReduceResult;
export declare function isValidValue(value: unknown): boolean;

export declare const PRODUCTS: Record<ActionKind, ProductId>;
export declare const ACTION_KINDS: ActionKind[];
export declare const ACTION_SET: Set<ActionKind>;
export declare const TRIGGER_KINDS: TriggerKind[];
export declare const TRIGGER_SET: Set<TriggerKind>;
export declare const ROBOT_ACTIONS: ActionKind[];
export declare const ROLES: ElementRole[];
export declare const ROLE_RANK: Record<ElementRole, number>;
