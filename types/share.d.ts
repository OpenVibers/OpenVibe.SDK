import type { Db, Tx } from './db';
import type { SubjectRef } from './contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
export type Audience = 'public' | 'link' | 'people' | 'private';
export type Role = 'viewer' | 'editor';
/** How an item is sealed (Locker). `none` is stored as it is. */
export type Lock = 'none' | 'people' | 'password' | 'link';
export interface ResourceRef { service: string; kind: string; id: string }
/** Trusted output of service authentication. Never constructed from a request body. */
export interface Viewer { subject: SubjectRef; staff?: boolean }
/** The content key wrapped for one person (locker.people-slot@1). The server stores it, never opens it. */
export interface PeopleSlot {
    subject: SubjectRef;
    algorithm: 'ECDH-P256/HKDF-SHA256/AES-256-GCM';
    /** The RFC 7638 thumbprint of the recipient's ECDH key: what the store checks against the key directory. */
    recipient_key: string;
    ephemeral_public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    salt: string;
    nonce: string;
    wrapped_key: string;
}
export type MemberInput = ({ name: string; subject?: never } | { subject: SubjectRef; name?: never }) & { role: Role; expires_at?: string; key_slot?: PeopleSlot };
export interface Member { subject: SubjectRef; role: Role; expires_at?: string; added_by: SubjectRef; added_at: string; key_slot?: PeopleSlot }
/** What the owner of a people-locked item sees per member: their current fingerprint, and whether it changed. */
export interface MemberKeyInfo { key_fingerprint?: string | null; fingerprint_changed?: boolean }
/** Network's public projection of a person. An unknown subject has a null username. */
export interface Person { subject: SubjectRef; username: string | null; display_name: string | null; avatar_url: string | null }
export interface You { subject: SubjectRef; role: 'owner' | 'staff' }
export interface AccessRequestView extends Person { id: string; requested_at: string }
export interface Transfer { id: string; from: SubjectRef; to: SubjectRef; keep_access: boolean; requested_at: string; expires_at: string; state: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' }
export interface TransferView extends Omit<Transfer, 'to'> { to: Person }
export interface Share { ref: ResourceRef; owner_subject: SubjectRef; audience: Audience; lock: Lock; members: Member[]; transfer?: Transfer }
/** The store's enriched share: people in place of bare subjects, the caller's role and pending requests. */
export interface ShareView extends Omit<Share, 'members' | 'transfer'> {
    owner: Person;
    members: Array<Member & Person & MemberKeyInfo>;
    transfer?: TransferView;
    you: You;
    requests: AccessRequestView[];
}
/** What the HTTP router answers: ShareView plus the service's describe(ref). */
export interface ShareResponse extends ShareView {
    title: string | null;
    link: string | null;
    roles: Role[];
    audiences: Audience[];
    transferable: boolean;
}
export interface AccessRequest { id: string; subject: SubjectRef; requested_at: string; state: 'pending' | 'granted' | 'dismissed' }
export interface PeopleLookup { person: Person | null }
export interface ShareList { items: Array<{ ref: ResourceRef; owner_subject: SubjectRef; audience: Audience; role: Role; shared_at: string; transfer?: Transfer }>; next_cursor: string | null }
export interface Notification { kind: 'share.added' | 'share.access_requested' | 'share.transfer.requested' | 'share.transfer.answered'; to: SubjectRef; actor: SubjectRef; ref: ResourceRef; delivery_id: string; action?: string; audience?: Audience; transfer_id?: string; request_id?: string; state?: Transfer['state'] }
export interface ShareEvent { event_id: string; event_type: 'share.granted' | 'share.revoked' | 'share.transfer.requested' | 'share.transfer.accepted' | 'share.transfer.declined'; version: number; timestamp: string; source: string; actor: SubjectRef; subject: { type: string; id: string }; payload: { ref: ResourceRef; actor: SubjectRef; owner_subject: SubjectRef; audience: Audience; subject: SubjectRef; occurred_at: string; role?: Role; expires_at?: string; transfer?: Transfer; reason?: 'member_added' | 'member_removed' | 'member_expired' | 'audience_changed' | 'transfer_cancelled' | 'transfer_expired' | 'ownership_changed'; transfer_id?: string } }
export interface ShareOptions {
    db: Db;
    network: { json(options: { service: string; audience: string; path: string; query?: { username: string }; method?: string; json?: unknown }): Promise<unknown> };
    events: { publish(event: ShareEvent): Promise<unknown> };
    notify(notification: Notification): Promise<unknown>;
    /** Transactional hooks: write local resource/media state through tx; never external I/O. */
    onOwnerChange?(ref: ResourceRef, from: SubjectRef, to: SubjectRef, tx: Tx): Promise<unknown>;
    onAudienceChange?(ref: ResourceRef, audience: Audience, tx: Tx): Promise<unknown>;
    /**
     * Stores a re-sealed envelope (a `locker.envelope@1` for the people who stay) when somebody is
     * removed from a people-locked item. Called inside the transaction, before the member row goes.
     * A service that allows people locks must pass it; otherwise a removal answers 409 share.reseal_unavailable.
     */
    onReseal?(ref: ResourceRef, envelope: Uint8Array, tx: Tx): Promise<unknown>;
    now?(): number;
    nameLimit?: number;
    nameWindowMs?: number;
}
export interface Shares {
    migrate(): Promise<void>;
    register(ref: ResourceRef, input: { owner_subject: SubjectRef; audience?: Audience; lock?: Lock }): Promise<Share>;
    canView(viewer: Viewer | null, ref: ResourceRef): Promise<boolean>;
    canEdit(viewer: Viewer | null, ref: ResourceRef): Promise<boolean>;
    get(viewer: Viewer, ref: ResourceRef): Promise<ShareView>;
    getWithRevision(viewer: Viewer, ref: ResourceRef): Promise<{ value: ShareView; etag: string }>;
    /** Add person projections and the caller's role to a raw share without another ownership read. */
    present(viewer: Viewer, ref: ResourceRef, share: Share): Promise<ShareView>;
    /** Exact @name → person (null when unknown, banned or deleted), on the same rate-limit budget as resolve(). */
    lookup(viewer: Viewer, name: string): Promise<PeopleLookup>;
    update(viewer: Viewer, ref: ResourceRef, input: { audience?: Audience; members?: MemberInput[]; notify?: boolean; lock?: Lock; envelope?: string }, options?: { ifMatch?: string }): Promise<Share>;
    setAudience(viewer: Viewer, ref: ResourceRef, audience: Audience): Promise<Share>;
    addMembers(viewer: Viewer, ref: ResourceRef, members: Array<MemberInput | SubjectRef | string>): Promise<Share>;
    /** On a people-locked item, `envelope` is required: the content re-sealed for those who stay. */
    removeMember(viewer: Viewer, ref: ResourceRef, subject: SubjectRef, options?: { envelope?: string }): Promise<Share>;
    requestAccess(viewer: Viewer, ref: ResourceRef): Promise<AccessRequest>;
    dismiss(viewer: Viewer, ref: ResourceRef, requestId: string): Promise<Share>;
    transfer(viewer: Viewer, ref: ResourceRef, input: { to: SubjectRef | string | { subject: SubjectRef } | { name: string }; keep_access?: boolean; key_slot?: PeopleSlot }): Promise<Transfer>;
    accept(viewer: Viewer, ref: ResourceRef, transferId: string): Promise<Transfer>;
    decline(viewer: Viewer, ref: ResourceRef, transferId: string): Promise<Transfer>;
    cancel(viewer: Viewer, ref: ResourceRef, transferId: string): Promise<Transfer>;
    expireMembers(options?: { limit?: number }): Promise<number>;
    sharedWithMe(viewer: Viewer, options?: { service?: string; limit?: number; cursor?: string }): Promise<ShareList>;
    flush(options?: { limit?: number }): Promise<number>;
    router(options: { service: string; authenticate(req: IncomingMessage): Viewer | null | Promise<Viewer | null>; describe?(ref: ResourceRef): Partial<Pick<ShareResponse, 'title' | 'link' | 'roles' | 'audiences' | 'transferable'>> | Promise<Partial<Pick<ShareResponse, 'title' | 'link' | 'roles' | 'audiences' | 'transferable'>>>; csrf?: boolean }): (req: IncomingMessage, res: ServerResponse, next?: () => unknown) => Promise<unknown>;
}
export function createShares(options: ShareOptions): Shares;
export function sharesSchema(): string;
export function migrateShares(db: Db): Promise<void>;
export class ShareError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) }
export interface ShareResourceClient {
    get(): Promise<ShareResponse>;
    update(input: { audience?: Audience; members?: MemberInput[]; notify?: boolean; lock?: Lock; envelope?: string }, options?: { ifMatch?: string }): Promise<ShareResponse>;
    setAudience(audience: Audience): Promise<ShareResponse>;
    add(target: string | SubjectRef, options?: { role?: Role; expires_at?: string }): Promise<ShareResponse>;
    remove(subject: SubjectRef): Promise<ShareResponse>;
    /** A people-locked item: looks up their key, wraps the content key for it, saves the member and the slot. */
    addLocked(target: string | SubjectRef, options: { contentKey: Uint8Array | string; role?: Role; expires_at?: string }): Promise<ShareResponse>;
    /**
     * A people-locked item: removes a member with a re-seal. With `contentKey`, `envelope` is the item's
     * current envelope, opened and sealed again for the people who stay (the owner keeps their slot);
     * without it, `envelope` is the envelope already re-sealed. `keys` ({ subject, publicKey }[]) skips
     * the key-directory lookups.
     */
    removeLocked(target: string | SubjectRef, options: { contentKey?: Uint8Array | string; envelope?: Uint8Array | { bytes: Uint8Array }; keys?: Array<{ subject: SubjectRef; publicKey: unknown }> }): Promise<ShareResponse>;
    requestAccess(): Promise<AccessRequest>;
    dismiss(requestId: string): Promise<ShareResponse>;
    transfer(to: string | SubjectRef, options?: { keep_access?: boolean; key_slot?: PeopleSlot }): Promise<Transfer | ShareResponse>;
    accept(transferId: string): Promise<Transfer>;
    decline(transferId: string): Promise<Transfer>;
    cancel(transferId: string): Promise<ShareResponse>;
}
export function share(options: { base: string; token?: string; fetch?: typeof globalThis.fetch; /** Where the key directory is; defaults to https://openvibe.network. */ network?: string }): { for(kind: string, id: string): ShareResourceClient; sharedWithMe(options?: { limit?: number; cursor?: string }): Promise<ShareList>; people(name: string): Promise<PeopleLookup> };
export const createShareClient: typeof share;
export function shareOpenApi(): { openapi: string; info: { title: string; version: string }; paths: Record<string, unknown>; components: Record<string, unknown> };
