/** platform.runtime-offer@1 and platform.runtime-class@1: execution capacity and environment kinds. Validated
 *  by openvibe-contracts (required lazily by the validate* functions). */
export type RuntimeOfferLimits = { cpu_cores: number; memory_mb: number; duration_seconds?: number; concurrency?: number };
export type RuntimeOfferPrice = { amount_usd: number; unit: 'second' | 'hour' | 'invocation' };
export type RuntimeOffer = { id: string; kind: 'container' | 'process' | 'wasm' | 'vm' | 'function'; region: string;
    node: string; limits: RuntimeOfferLimits; price: RuntimeOfferPrice; availability: 'available' | 'limited' | 'unavailable';
    constraints: string[] };
export type RuntimeClass = 'function' | 'code' | 'browser' | 'linux' | 'desktop' | 'gpu';
export type ValidationError = { path: string; message: string };
/** Null/undefined fields are stripped. */
export declare function runtimeOffer(fields: Partial<RuntimeOffer>): RuntimeOffer;
/** Returns the class when it is a known runtime class, or throws. */
export declare function runtimeClass(value: string): RuntimeClass;
export declare const RUNTIME_CLASSES: RuntimeClass[];
export declare function validateRuntimeOffer(record: unknown): { ok: boolean; errors: ValidationError[] };
export declare function validateRuntimeClass(value: unknown): { ok: boolean; errors: ValidationError[] };
