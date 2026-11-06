import type { Db, Tx } from './db';
import type { SubjectRef } from './contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
export type Audience = 'public' | 'link' | 'people' | 'private';
export type Role = 'viewer' | 'editor';
export interface ResourceRef { service: string; kind: string; id: string }
/** Trusted output of service authentication. Never constructed from a request body. */
export interface Viewer { subject: SubjectRef; staff?: boolean }
export type MemberInput = ({ name: string; subject?: never } | { subject: SubjectRef; name?: never }) & { role: Role; expires_at?: string };
export interface Member { subject: SubjectRef; role: Role; expires_at?: string; added_by: SubjectRef; added_at: string }
export interface Transfer { id: string; from: SubjectRef; to: SubjectRef; keep_access: boolean; requested_at: string; expires_at: string; state: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' }
export interface Share { ref: ResourceRef; owner_subject: SubjectRef; audience: Audience; members: Member[]; transfer?: Transfer }
export interface AccessRequest { id: string; subject: SubjectRef; requested_at: string; state: 'pending' | 'granted' }
export interface ShareList { items: Array<{ ref: ResourceRef; owner_subject: SubjectRef; audience: Audience; role: Role; shared_at: string; transfer?: Transfer }>; next_cursor: string | null }
export interface Notification { kind: 'share.added' | 'share.access_requested' | 'share.transfer.requested' | 'share.transfer.answered'; to: SubjectRef; actor: SubjectRef; ref: ResourceRef; delivery_id: string; action?: string; audience?: Audience; transfer_id?: string; request_id?: string; state?: Transfer['state'] }
export interface ShareEvent { event_id: string; event_type: 'share.granted' | 'share.revoked' | 'share.transfer.requested' | 'share.transfer.accepted' | 'share.transfer.declined'; version: number; timestamp: string; source: string; actor: SubjectRef; subject: { type: string; id: string }; payload: { ref: ResourceRef; actor: SubjectRef; owner_subject: SubjectRef; audience: Audience; subject: SubjectRef; occurred_at: string; role?: Role; expires_at?: string; transfer?: Transfer; reason?: 'member_added' | 'member_removed' | 'member_expired' | 'audience_changed' | 'transfer_cancelled' | 'transfer_expired' | 'ownership_changed'; transfer_id?: string } }
export interface ShareOptions {
    db: Db;
    network: { json(options: { service: string; audience: string; path: string; query: { username: string } }): Promise<unknown> };
    events: { publish(event: ShareEvent): Promise<unknown> };
    notify(notification: Notification): Promise<unknown>;
    /** Transactional hooks: write local resource/media state through tx; never external I/O. */
    onOwnerChange?(ref: ResourceRef, from: SubjectRef, to: SubjectRef, tx: Tx): Promise<unknown>;
    onAudienceChange?(ref: ResourceRef, audience: Audience, tx: Tx): Promise<unknown>;
    now?(): number;
    nameLimit?: number;
    nameWindowMs?: number;
}
export interface Shares {
    migrate(): Promise<void>;
    register(ref: ResourceRef, input: { owner_subject: SubjectRef; audience?: Audience }): Promise<Share>;
    canView(viewer: Viewer | null, ref: ResourceRef): Promise<boolean>;
    canEdit(viewer: Viewer | null, ref: ResourceRef): Promise<boolean>;
    get(viewer: Viewer, ref: ResourceRef): Promise<Share>;
    getWithRevision(viewer: Viewer, ref: ResourceRef): Promise<{ value: Share; etag: string }>;
    update(viewer: Viewer, ref: ResourceRef, input: { audience?: Audience; members?: MemberInput[] }, options?: { ifMatch?: string }): Promise<Share>;
    setAudience(viewer: Viewer, ref: ResourceRef, audience: Audience): Promise<Share>;
    addMembers(viewer: Viewer, ref: ResourceRef, members: Array<MemberInput | SubjectRef | string>): Promise<Share>;
    removeMember(viewer: Viewer, ref: ResourceRef, subject: SubjectRef): Promise<Share>;
    requestAccess(viewer: Viewer, ref: ResourceRef): Promise<AccessRequest>;
    transfer(viewer: Viewer, ref: ResourceRef, input: { to: SubjectRef | string; keep_access?: boolean }): Promise<Transfer>;
    accept(viewer: Viewer, ref: ResourceRef, transferId: string): Promise<Transfer>;
    decline(viewer: Viewer, ref: ResourceRef, transferId: string): Promise<Transfer>;
    cancel(viewer: Viewer, ref: ResourceRef, transferId: string): Promise<Transfer>;
    expireMembers(options?: { limit?: number }): Promise<number>;
    sharedWithMe(viewer: Viewer, options?: { service?: string; limit?: number; cursor?: string }): Promise<ShareList>;
    flush(options?: { limit?: number }): Promise<number>;
    router(options: { service: string; authenticate(req: IncomingMessage): Viewer | null | Promise<Viewer | null> }): (req: IncomingMessage, res: ServerResponse, next?: () => unknown) => Promise<unknown>;
}
export function createShares(options: ShareOptions): Shares;
export function sharesSchema(): string;
export function migrateShares(db: Db): Promise<void>;
export class ShareError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) }
export interface ShareResourceClient {
    get(): Promise<Share>;
    update(input: { audience?: Audience; members?: MemberInput[] }, options?: { ifMatch?: string }): Promise<Share>;
    setAudience(audience: Audience): Promise<Share>;
    add(target: string | SubjectRef, options?: { role?: Role; expires_at?: string }): Promise<Share>;
    remove(subject: SubjectRef): Promise<Share>;
    requestAccess(): Promise<AccessRequest>;
    transfer(to: string | SubjectRef, options?: { keep_access?: boolean }): Promise<Transfer>;
    accept(transferId: string): Promise<Transfer>;
    decline(transferId: string): Promise<Transfer>;
    cancel(transferId: string): Promise<Transfer>;
}
export function share(options: { base: string; token?: string; fetch?: typeof globalThis.fetch }): { for(kind: string, id: string): ShareResourceClient; sharedWithMe(options?: { limit?: number; cursor?: string }): Promise<ShareList> };
export const createShareClient: typeof share;
export function shareOpenApi(): { openapi: string; info: { title: string; version: string }; paths: Record<string, unknown>; components: Record<string, unknown> };
