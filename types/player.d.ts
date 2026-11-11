export interface CurrentPlayer {
    id: string;
    src: string;
    title: string;
    href?: string;
    live: boolean;
    sound: boolean;
    playing?: boolean;
    side?: { src: string; title: string };
}
export interface PlayerEvent { reason: 'open' | 'close' | 'declare' | 'handoff' | 'state'; card: CurrentPlayer | null }
/** The active portable live stream, if one exists on this page. */
export function current(): CurrentPlayer | null;
/** Add the active player to an OpenVibe destination URL for same-tab navigation. */
export function handoff(url: string): string;
/** Subscribe to changes. Returns a function that removes the listener. */
export function on(listener: (event: PlayerEvent) => void): () => void;
