import type { Client } from './core';

export interface DesignComponent {
  schema: 'design.component@1';
  name: string;
  title: string;
  summary: string;
  anatomy: Array<{ part: string; role: string }>;
  props: Record<string, string>;
  states: string[];
  tokens: string[];
  behaviors: { keyboardAware: boolean; outsideTapCloses: boolean; scrollLock: boolean; reducedMotion: string };
  accessibility: { name: string; target: string; focus: string };
  platforms: {
    web: { module: string; markup: string; demo: string };
    android: { toolkit: 'Jetpack Compose'; material3: string; specification: string };
    ios: { toolkit: 'SwiftUI'; specification: string };
  };
  examples: Array<{ title: string; props: Record<string, unknown> }>;
}

export interface DesignClient {
  components(options?: { signal?: AbortSignal }): Promise<{ schema: 'design.component@1'; components: DesignComponent[]; kitComponents: unknown[] }>;
  component(name: string, options?: { signal?: AbortSignal }): Promise<{ schema: 'design.component@1'; component: DesignComponent; examples: DesignComponent['examples'] } | null>;
}

export function createDesignClient(client: Client, options?: { baseUrl?: string }): DesignClient;
