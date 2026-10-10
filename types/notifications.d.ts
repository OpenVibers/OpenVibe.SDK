import type { OpenVibeClient } from './core';

/** network.notification-push-request@1 fields, minus the recipient (push() resolves it). */
export interface NotificationFields {
    type?: string;
    title?: string;
    message?: string | null;
    url?: string;
    category?: 'service' | 'social' | 'system' | string;
    priority?: 'low' | 'normal' | 'high' | 'critical' | string;
    icon?: string;
    rich_content?: Record<string, unknown>;
    service?: string;
    [field: string]: unknown;
}
export type PushInput = ({ subjectId: string; userId?: undefined } | { userId: number | string; subjectId?: undefined }) & NotificationFields;
export type PushResult = { sent: true; skipped: boolean } | { sent: false; reason: 'unknown_subject' };

export interface NotificationsClient {
    push(input: PushInput): Promise<PushResult>;
}
export declare function createNotificationsClient(client: OpenVibeClient, opts?: { baseUrl?: string }): NotificationsClient;
