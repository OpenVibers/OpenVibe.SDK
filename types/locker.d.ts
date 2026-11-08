/**
 * openvibe-sdk/locker: end-to-end encryption for anything on OpenVibe.
 *
 * One format, one library, two runtimes: Node and the browser, WebCrypto only. A locked item is
 * stored and served as ciphertext; the keys never reach our servers.
 */
export type LockKind = 'people' | 'password' | 'link';
export type SubjectRef = { type: string; id: string };

/** A P-256 public key as a JWK. */
export interface PublicKeyJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string; ext?: boolean; key_ops?: string[] }

/** The key slot of one person: the content key, wrapped for their public key. */
export interface PeopleSlot {
    subject: SubjectRef;
    algorithm: 'ECDH-P256/HKDF-SHA256/AES-256-GCM';
    /** The RFC 7638 thumbprint of the recipient's ECDH public key: the slot is bound to it. */
    recipient_key: string;
    ephemeral_public_key: PublicKeyJwk;
    salt: string;
    nonce: string;
    wrapped_key: string;
}

/** The key slot of a password: the content key, wrapped with PBKDF2-SHA-256. */
export interface PasswordSlot {
    algorithm: 'PBKDF2-SHA256/AES-256-GCM';
    kdf: 'PBKDF2-SHA-256';
    iterations: number;
    salt: string;
    nonce: string;
    wrapped_key: string;
}

/** The header of an envelope. The content key is never in it. */
export interface LockerHeader {
    version: 'locker.envelope.v1';
    suite: 'AES-256-GCM';
    chunk_size: number;
    padded_size: number;
    nonce_base: string;
    lock: LockKind;
    slots: { people?: PeopleSlot[]; password?: PasswordSlot; link?: Record<string, never> };
}

/** What an envelope says about itself: the header, read without a key. */
export interface EnvelopeInfo {
    version: string;
    lock: LockKind;
    padded_size: number;
    /** For a people lock: the thumbprint of each recipient's key. */
    recipients: string[];
    /** For a password lock: the PBKDF2 iteration count. */
    iterations: number | null;
}

/** A sealed envelope: its bytes and its header. */
export interface Envelope {
    version: string;
    header: LockerHeader;
    headerBytes: Uint8Array;
    bytes: Uint8Array;
    chunkOffset: number;
    /** A link lock only: the content key, which travels in the part of the link after the #. */
    linkKey?: string;
}

/** A person's two key pairs, in memory. */
export interface PersonKeys {
    ecdh: { publicKey: CryptoKey; privateKey: CryptoKey };
    signing: { publicKey: CryptoKey; privateKey: CryptoKey };
    ecdhPublic: PublicKeyJwk;
    signingPublic: PublicKeyJwk;
    fingerprint: string;
    fingerprintSignature: Uint8Array;
}

/** A person's public keys, as they are published: locker.public-keys@1. */
export interface PublicKeys {
    ecdh: PublicKeyJwk;
    signing: PublicKeyJwk;
    fingerprint: string;
    fingerprint_signature: string;
}

/** What a seal needs. */
export interface SealOptions {
    lock: LockKind;
    /** A people lock: the recipients, each with their public key. */
    keys?: Array<{ subject: SubjectRef; publicKey: PublicKeyJwk }>;
    /** A password lock. */
    password?: string;
    /** A link lock: the content key, if the caller has one. */
    contentKey?: Uint8Array;
    /** The PBKDF2 iteration count of a password lock. */
    iterations?: number;
    /** Test vectors only: a fixed byte source instead of the platform's. */
    random?: (length: number) => Uint8Array;
    /** Test vectors only: a fixed ephemeral key pair. */
    ephemeral?: { private?: Record<string, unknown>; privateKey?: CryptoKey; publicKey?: CryptoKey };
}

/** What an open needs: the credentials of the lock it names. */
export interface OpenCredentials {
    /** A people lock: the private key of a recipient. */
    privateKey?: CryptoKey | Record<string, unknown>;
    /** A people lock: which person you are. */
    subject?: SubjectRef | string;
    /**
     * A people lock: the person who is opening, with their ECDH key. The slot that names their
     * key is found without knowing anybody's subject; an envelope with no slot for that key
     * fails with locker.no_slot.
     */
    person?: {
        ecdhPublic?: PublicKeyJwk;
        ecdh?: { publicKey?: CryptoKey; privateKey?: CryptoKey } | PublicKeyJwk;
        ecdhPrivateKey?: CryptoKey;
        privateKey?: CryptoKey;
        kty?: string;
        crv?: string;
        x?: string;
        y?: string;
    };
    /** A password lock. */
    password?: string;
    /** A link lock: the key from the link. */
    key?: Uint8Array | string;
}

/** What a re-wrap needs: who to add, who to drop, and how to open it first. */
export interface RewrapOptions {
    add?: Array<{ subject: SubjectRef; publicKey: PublicKeyJwk }>;
    remove?: Array<SubjectRef | string>;
    /** The public keys of the people who stay: a removal re-seals, and that needs their keys. */
    keys?: Array<{ subject: SubjectRef; publicKey: PublicKeyJwk }>;
    credentials?: OpenCredentials;
    random?: (length: number) => Uint8Array;
    ephemeral?: { private?: Record<string, unknown>; privateKey?: CryptoKey; publicKey?: CryptoKey };
}

export class LockerError extends Error {
    code: string;
}

/** Seals content: a string or bytes. */
export function seal(content: string | Uint8Array | ArrayBuffer, options: SealOptions): Promise<Envelope>;
/** Opens an envelope: the content as bytes. */
export function open(envelope: Envelope | Uint8Array, credentials?: OpenCredentials): Promise<Uint8Array>;
/** Seals a stream: the envelope comes out piece by piece. The size of the content is needed. */
export function sealStream(stream: ReadableStream<Uint8Array>, options: SealOptions & { size: number }): ReadableStream<Uint8Array>;
/**
 * Opens a stream: the content comes out piece by piece, as the chunks are verified. A stream that
 * ends early throws at the end, when the missing chunk shows up: discard what it yielded.
 */
export function openStream(stream: ReadableStream<Uint8Array>, credentials?: OpenCredentials): ReadableStream<Uint8Array>;
/** Wraps the content key for other people, without touching the content. */
export function rewrap(envelope: Envelope | Uint8Array, options?: RewrapOptions): Promise<Envelope>;

/** A person's two key pairs, made in the browser. */
export function generatePersonKeys(): Promise<PersonKeys>;
/** The public half of a person's keys, as it is published. */
export function exportPersonKeys(person: PersonKeys | Awaited<ReturnType<typeof importPersonKeys>>): Promise<PublicKeys>;
/** The private half of a person's keys, as it is stored. */
export function exportPrivateKeys(person: PersonKeys | Awaited<ReturnType<typeof importPersonKeys>>): Promise<{ ecdh: Record<string, unknown>; signing: Record<string, unknown> }>;
/** A person's keys, ready to use. */
export function importPersonKeys(data: { ecdh?: Record<string, unknown>; signing?: Record<string, unknown>; ecdhPrivateKey?: CryptoKey; signingPrivateKey?: CryptoKey }): Promise<{ ecdhPrivateKey: CryptoKey; signingPrivateKey: CryptoKey; ecdhPublic: PublicKeyJwk; signingPublic: PublicKeyJwk }>;
/** Checks a published set of keys: the signature and the eight words. */
export function verifyPersonKeys(data: PublicKeys): Promise<boolean>;
/** The eight words of a pair of public keys. */
export function fingerprintOf(ecdhPublic: PublicKeyJwk, signingPublic: PublicKeyJwk): Promise<string>;
/** The eight words of a hash. */
export function fingerprintWords(hash: Uint8Array): string;
/** The RFC 7638 thumbprint of a public key: SHA-256 over the canonical JSON of its members, base64url. */
export function jwkThumbprint(jwk: PublicKeyJwk): Promise<string>;
/** The padded size of a content of this size: Padme's grid, never below the floor. */
export function padme(size: number): number;

/** What an envelope says about itself, without a key and without decrypting anything. */
export function inspect(bytes: Uint8Array | Envelope): EnvelopeInfo;

/** A recovery phrase: n words from the list, one byte each. */
export function recoveryWords(count?: number, options?: { random?: (length: number) => Uint8Array }): string;
/** Whether every word of a typed phrase is one of the 256. */
export function isRecoveryPhrase(phrase: string): boolean;

/** Wraps the content key for one person. */
export function wrapFor(contentKey: Uint8Array, publicKey: PublicKeyJwk, options: { subject: SubjectRef; salt?: Uint8Array; random?: (length: number) => Uint8Array; ephemeral?: { private?: Record<string, unknown>; privateKey?: CryptoKey; publicKey?: CryptoKey } }): Promise<PeopleSlot>;
/** Wraps the content key with a password. */
export function wrapForPassword(contentKey: Uint8Array, password: string, options?: { salt?: Uint8Array; iterations?: number; random?: (length: number) => Uint8Array }): Promise<PasswordSlot>;
/** The content key out of a people slot. */
export function unwrapPeopleSlot(slot: PeopleSlot, privateKey: CryptoKey): Promise<Uint8Array>;
/** The content key out of a password slot. */
export function unwrapPasswordSlot(slot: PasswordSlot, password: string): Promise<Uint8Array>;

export const VERSION: string;
export const SUITE: string;
export const CHUNK_SIZE: number;
export const MIN_PADDED_SIZE: number;
export const MAX_HEADER_BYTES: number;
export const PASSWORD_ITERATIONS: number;
export const PASSWORD_ITERATIONS_MIN: number;
export const PASSWORD_ITERATIONS_MAX: number;
/** How many words a recovery phrase has, unless the caller says otherwise. */
export const RECOVERY_WORDS: number;
/** The 256 words a fingerprint and a recovery phrase are made of. */
export const WORDS: string[];
