/**
 * openvibe-sdk/locker/vectors: the shared test vectors.
 *
 * The browser module (openvibe-shared/ov-locker.js) runs the same cases, so both runtimes must
 * produce the same bytes for the same input: the same header, the same envelope, the same eight
 * words, the same recovery phrase and the same reading of each envelope.
 */
import type { LockerHeader, PublicKeyJwk } from './locker';

/** A fixed byte source: the same bytes every time. A test helper, never for anything real. */
export function fixedRandom(seed?: number): (length: number) => Uint8Array;

/** The content of every case. */
export const CONTENT: string;

/** A person's keys, made for these vectors. */
export const PERSON: {
    ecdh: Record<string, unknown>;
    signing: Record<string, unknown>;
    ecdhPublic: PublicKeyJwk;
    signingPublic: PublicKeyJwk;
    fingerprint: string;
};

/** The subject the people case is for. */
export const SUBJECT: { type: string; id: string };

/** One case: the same content, sealed one way, and what it must produce. */
export interface VectorCase {
    name: string;
    envelope_sha256: string;
    header: LockerHeader;
}

/** The cases. */
export const CASES: VectorCase[];

/** A recovery phrase from a fixed byte source: the same words on every runtime. */
export const RECOVERY: { phrase: string; words: string[] };

/** What inspect() says about each case: the header, read without a key. */
export const INSPECT: Record<string, {
    version: string;
    lock: string;
    padded_size: number;
    recipients: string[];
    iterations: number | null;
}>;
