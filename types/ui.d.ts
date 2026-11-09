export type ProgressState = 'waiting' | 'sending' | 'paused' | 'processing' | 'done' | 'failed';
export interface ProgressUpdate {
    state?: ProgressState;
    done?: number;
    total?: number;
    message?: string;
}
/** Requires the shared ov-upload.js and ov-upload.css assets on the page. */
export declare function progress(el: HTMLElement, options?: { onRetry?(): void }): {
    update(next: ProgressUpdate): void;
    destroy(): void;
};
