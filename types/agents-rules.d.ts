// openvibe-sdk/agents/rules: permissions as data (agents.permission-rule@1).
export type Effect = 'allow' | 'ask' | 'deny';
export type Level = 'ask' | 'auto-edits' | 'approve-for-me' | 'full';
export interface PermissionRule { action: string; resource?: string; effect: Effect; when?: 'attended' | 'unattended' | 'any'; reason?: string; }
export interface Call { action: string; resource?: string; floor?: boolean; kind?: 'read' | 'edit' | 'exec' | 'network' | 'other'; }
export function decide(rules: PermissionRule[], call: Call, options?: { attended?: boolean; level?: Level }): { effect: Effect; rule: PermissionRule | null; why: string };
export function fromBlueprint(doc: object): PermissionRule[];
export function matches(pattern: string | null | undefined, value: string): boolean;
export const LEVELS: Level[];
export const EFFECTS: Effect[];
export const MACHINE_KIND: Record<string, string>;
