/** platform.storage-offer@1: durable storage capacity and operation pricing. Validated by openvibe-contracts
 *  (required lazily by validateStorageOffer). */
export type StorageOfferDurability = { replicas: number; target_nines?: number };
export type StorageOfferLifecycleRule = { after_days: number; action: 'transition' | 'expire'; target_class?: 'hot' | 'warm' | 'cold' };
export type StorageOffer = { id: string; class: 'hot' | 'warm' | 'cold'; capacity_gb: number;
    price_per_gb_month_usd: number; price_per_operation_usd: number; region: string; node: string;
    durability: StorageOfferDurability; lifecycle_rules: StorageOfferLifecycleRule[] };
export type ValidationError = { path: string; message: string };
/** Null/undefined fields are stripped. */
export declare function storageOffer(fields: Partial<StorageOffer>): StorageOffer;
export declare function validateStorageOffer(record: unknown): { ok: boolean; errors: ValidationError[] };
