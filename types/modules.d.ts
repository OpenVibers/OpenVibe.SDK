import type { OpenVibeClient, ModuleRecord, SubjectRef } from './core';

export type Updater<T> = (data: T | undefined, record: ModuleRecord | null) => T | undefined | Promise<T | undefined>;

export interface ModulesClient {
    list(): Promise<{ subject: SubjectRef; modules: ModuleRecord[]; namespaces: Array<{ namespace: string; owner: string; userWritable: boolean; description?: string }> }>;
    get(ns: string): Promise<ModuleRecord | null>;
    put<T extends object>(ns: string, data: T, opts: { revision: number }): Promise<ModuleRecord>;
    delete(ns: string): Promise<boolean>;
    /** Read-modify-write; retries on 412 up to `attempts` (default 5). */
    update<T extends object>(ns: string, fn: Updater<T>, opts?: { attempts?: number }): Promise<ModuleRecord | null>;
    publicGet(ns: string, subjectId: string): Promise<{ subject: SubjectRef; namespace: string; version: number; data: Record<string, unknown> } | null>;
    /** Service side (token with network.modules.read / .write for the namespace). */
    forSubject: {
        get(ns: string, subjectId: string): Promise<ModuleRecord | null>;
        put<T extends object>(ns: string, subjectId: string, data: T, opts?: { revision?: number }): Promise<ModuleRecord>;
        update<T extends object>(ns: string, subjectId: string, fn: Updater<T>, opts?: { attempts?: number }): Promise<ModuleRecord | null>;
    };
}
export declare function createModulesClient(client: OpenVibeClient, opts?: { baseUrl?: string; maxAttempts?: number }): ModulesClient;
