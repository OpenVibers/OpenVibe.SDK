import type { OpenVibeClient } from './core';

/** One person in the circle (network.friend-circle@1). */
export interface FriendPerson {
    subject: string;
    username: string | null;
    display_name: string | null;
    avatar_url?: string | null;
    /** Seen on an OpenVibe site in the last few minutes (Network's presence). */
    online: boolean;
    /** Where they are, when online and they share it. */
    site?: string | null;
    /** When this side of the friendship last changed. */
    since?: string | null;
}

/** The pair as the card shows it: none, pending (I added them), requested (they added me), friends. */
export type FriendState = 'none' | 'pending' | 'requested' | 'friends';

export interface FriendEntry {
    subject: string;
    username: string | null;
    display_name: string | null;
    active: boolean;
    /** This side's revision; it grows with every change of the pair. */
    revision: number;
    state: FriendState;
    added_at?: string;
}

/** The person's whole circle in one read (network.friend-circle@1). */
export interface FriendCircle {
    subject: string;
    /** Whom the person added (mutual and asked), for older readers. */
    friends: Array<{ subject: string }>;
    /** Friends: both added each other. */
    mutual: FriendPerson[];
    /** They added the person, the person did not add them. */
    requests: FriendPerson[];
    /** The person added them, they did not add the person. */
    asked: FriendPerson[];
}

/** A person's mutual friends as subjects only (network.friend-subjects@1). */
export interface FriendSubjects {
    subject: string;
    friends: string[];
}

export interface FriendsClient {
    /** The person's circle: network.friend-circle@1. */
    list(): Promise<FriendCircle>;
    /** Add someone (a usr_ subject or a username). */
    add(subjectOrUsername: string): Promise<{ changed: boolean; friend: FriendEntry }>;
    /** Accept a request: add them back. */
    accept(subjectOrUsername: string): Promise<{ changed: boolean; friend: FriendEntry }>;
    /** Remove them again. */
    remove(subjectOrUsername: string): Promise<{ changed: boolean; friend: FriendEntry }>;
    /** A service reads a person's mutual friends as subjects only (needs network.friends.read). */
    subjects(subject: string): Promise<FriendSubjects>;
}
export declare function createFriendsClient(client: OpenVibeClient, opts?: { baseUrl?: string }): FriendsClient;
