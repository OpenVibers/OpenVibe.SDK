/**
 * openvibe-sdk/locker/server: what a service needs to know about an envelope without opening it.
 *
 * The header's shape and the envelope's size. Nothing here decrypts anything, and nothing here
 * needs a key: a service may hold the bytes of an item it can never read.
 */
import type { LockerHeader, LockKind } from './locker';

/** What an envelope holds, as far as a service may know. */
export interface EnvelopeInfo {
    /** Whether the header and the size pass every check. */
    valid: boolean;
    /** What is wrong, in words, when something is. */
    errors: string[];
    /** The header itself. It holds no key material, only wrapped keys. */
    header: LockerHeader | null;
    headerLength: number;
    chunkOffset: number;
    lock: LockKind | undefined;
    /** The size of the padded plaintext: a whole number of chunks. */
    paddedSize: number | undefined;
    chunkCount: number | null;
    /** The bytes the envelope must have, if its own header is true. */
    expectedBytes: number | null;
}

/** Reads an envelope's header and checks its shape and its size. Nothing is decrypted. */
export function inspectEnvelope(bytes: Uint8Array, options?: { maxHeaderBytes?: number }): EnvelopeInfo;

/** The header's shape: what it says, and whether the slots match the lock it names. */
export function checkHeader(header: unknown): string[];
