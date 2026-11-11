import type { OpenVibeClient } from './core';

/** composer.attachment@1: one file a person attached to a message. */
export interface ComposerAttachment {
    id: string;
    kind: 'image' | 'video' | 'audio' | 'file' | 'code';
    name: string;
    size: number;
    mime: string;
    url: string;
    thumb?: string | null;
    w?: number | null;
    h?: number | null;
    expires_at: string;
}

/** composer.prefs@1: a person's composer settings on every site. */
export interface ComposerPrefs {
    /** The revision that was read; a PUT names it, and a moved one is 409 composer.rev_conflict. */
    rev: number;
    send_key: 'enter' | 'mod-enter';
    tools: Array<{ id: string; hidden: boolean }>;
    density: 'comfy' | 'compact';
    voice: boolean;
    snippets: Array<{ trigger: string; label: string; text: string }>;
}

/** The document a PUT sends: the fields, with rev = the revision it read (0 for a new person). */
export type ComposerPrefsInput = Omit<ComposerPrefs, 'rev'>;

/** composer.mention@1: one entry of the composer's @ menu. */
export interface ComposerMention {
    kind: 'person' | 'repo' | 'site' | 'file';
    id: string;
    label: string;
    handle?: string;
    avatar?: string | null;
    url: string;
}

export type ComposerFile = Blob | ArrayBuffer | ArrayBufferView | string;

export interface UploadOptions {
    onProgress?: (p: { loaded: number; total: number; lengthComputable: boolean }) => void;
    signal?: AbortSignal;
    filename?: string;
    contentType?: string;
    /** An XMLHttpRequest implementation, for a non-browser shell or a test. */
    xhr?: new () => XMLHttpRequest;
}

export interface ComposerClient {
    attachments: {
        upload(file: ComposerFile, opts?: UploadOptions): Promise<ComposerAttachment>;
        /** true when it was deleted, false when it was already gone. */
        remove(id: string): Promise<boolean>;
    };
    composer: {
        prefs: {
            get(): Promise<ComposerPrefs>;
            /** A stale rev rejects with an OpenVibeError: status 409, code composer.rev_conflict, err.problem.current. */
            put(prefs: ComposerPrefsInput, rev: number): Promise<ComposerPrefs>;
        };
    };
    mentions: {
        search(q?: string, kinds?: Array<'person' | 'repo' | 'site' | 'file'> | string): Promise<ComposerMention[]>;
    };
    MEDIA_ORIGIN: string;
    NETWORK_ORIGIN: string;
}

export declare function createComposerClient(client: OpenVibeClient, opts?: { mediaBaseUrl?: string; networkBaseUrl?: string }): ComposerClient;
export declare const MEDIA_ORIGIN: string;
export declare const NETWORK_ORIGIN: string;
export declare const ATTACHMENT_MAX: number;
