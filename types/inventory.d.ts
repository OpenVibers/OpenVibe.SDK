/** openvibe-sdk/inventory: OpenVibe.Inventory — kinds, item definitions, what people own and wear, and issuers' grants (ADR-054). */
type Opts = { signal?: AbortSignal };
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export interface Kind { id: string; name?: string; slots: string[]; surfaces?: string[]; schema?: Record<string, unknown>; [k: string]: unknown }
export interface Definition {
    id: string; kind: string; name: string; description?: string | null; rarity: Rarity; issuer: string;
    art?: { media_id?: string; token?: string; emoji?: string }; attributes?: Record<string, unknown>; supply_cap?: number | null;
    status?: 'draft' | 'in_review' | 'published' | 'retired'; [k: string]: unknown;
}
export interface DefinitionRequest { kind: string; name: string; description?: string; rarity?: Rarity; art?: Definition['art']; attributes?: Record<string, unknown>; supply_cap?: number; [k: string]: unknown }
export interface Instance { id: string; definition_id: string; owner_subject?: string; state?: 'owned' | 'consumed' | 'revoked'; serial?: number | null; [k: string]: unknown }
export interface EquippedSet { subject: string; slots: Record<string, { instance_id: string; definition_id: string; token?: string; media_id?: string }>; updated_at: string | null }
export interface InventoryClient {
    kinds: { list(opts?: Opts): Promise<{ kinds: Kind[] }>; get(kindId: string, opts?: Opts): Promise<{ kind: Kind }> };
    definitions: {
        list(opts?: Opts & { kind?: string; issuer?: string; limit?: number }): Promise<{ definitions: Definition[] }>;
        get(id: string, opts?: Opts): Promise<{ definition: Definition }>;
        create(definition: DefinitionRequest, opts?: Opts): Promise<{ definition: Definition }>;
        update(id: string, patch: Partial<DefinitionRequest>, opts?: Opts): Promise<{ definition: Definition }>;
    };
    people: {
        items(subject: string, opts?: Opts & { kind?: string; cursor?: string; limit?: number }): Promise<{ items: Instance[]; next: string | null; [k: string]: unknown }>;
        equipped(subject: string, opts?: Opts): Promise<EquippedSet>;
    };
    equipped(subjects: string[], opts?: Opts): Promise<{ equipped: EquippedSet[] }>;
    me: {
        items(opts?: Opts & { kind?: string; cursor?: string; limit?: number }): Promise<{ items: Instance[]; next: string | null; [k: string]: unknown }>;
        equip(req: { kind: string; slot: string; instance_id: string | null }, opts?: Opts): Promise<EquippedSet>;
    };
    grants: { create(req: { definition_id: string; subject: string; idempotency_key: string; [k: string]: unknown }, opts?: Opts): Promise<{ instance: Instance; created: boolean }> };
    instances: { consume(id: string, opts?: Opts): Promise<{ instance: Instance }>; revoke(id: string, opts?: Opts & { reason?: string }): Promise<{ instance: Instance }> };
    /** The same client acting for one person (sends X-OV-Subject). */
    forPerson(subject: string): InventoryClient;
}
export function createInventoryClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string; subject?: string }): InventoryClient;
