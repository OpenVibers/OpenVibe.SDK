/** platform.delivery-offer@1: transport and edge delivery capacity with cache policy and pricing. Validated by
 *  openvibe-contracts (required lazily by validateDeliveryOffer). */
export type DeliveryOfferCacheRules = { enabled: boolean; ttl_seconds?: number; max_object_mb?: number };
export type DeliveryOffer = { id: string; transports: ('http' | 'hls' | 'rtmp' | 'srt' | 'ws')[]; regions: string[];
    edge: boolean; node?: string; price_per_gb_usd: number; price_per_request_usd: number; cache_rules: DeliveryOfferCacheRules };
export type ValidationError = { path: string; message: string };
/** Null/undefined fields are stripped. */
export declare function deliveryOffer(fields: Partial<DeliveryOffer>): DeliveryOffer;
export declare function validateDeliveryOffer(record: unknown): { ok: boolean; errors: ValidationError[] };
