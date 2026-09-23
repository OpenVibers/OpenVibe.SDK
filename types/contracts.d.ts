/* Copied verbatim from openvibe-contracts v0.26.0 generated/typescript/index.d.ts (the SDK does not
 * require the package at runtime). test/types.test.js checks these against a Contracts checkout. */
/* eslint-disable */

/** identity.subject-ref@1.0.0 (owner: network) */
/**
 * The one cross-platform reference to an actor. Issued by OpenVibe.Network. Never a service-local integer id.
 */
export type SubjectRef =
  | {
      type: "user";
      id: string;
    }
  | {
      type: "guest";
      id: string;
    }
  | {
      type: "app";
      id: string;
    }
  | {
      type: "mod";
      id: string;
    }
  | {
      type: "service" | "system";
      id: string;
    };

/** identity.service-token-claims@1.2.0 (owner: network) */
/**
 * Claims of a short-lived RS256 client-credentials token issued by OpenVibe.Network to a service or app principal. Replaces X-Internal-Key. App tokens (actor_type app) also carry project_id and env; receivers refuse env=sandbox unless they opted in.
 */
export type ServiceTokenClaims = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Issuer; https://openvibe.network in production. Receivers pass the issuer they expect to verifyServiceToken().
   */
  iss: string;
  sub: string;
  actor_type: "service" | "app" | "mod";
  /**
   * @minItems 1
   */
  aud: [string, ...string[]];
  /**
   * Granted capability ids; a trailing .* grants a family.
   */
  cap: string[];
  /**
   * Namespace constraints, e.g. live.* or mod.example.*
   */
  ns?: string[];
  iat: number;
  exp: number;
  jti: string;
  /**
   * Developer project of an app principal (ADR-014). Services key tenancy by it. Absent on first-party service tokens.
   */
  project_id?: string;
  /**
   * Environment of an app principal. A receiver MUST refuse env=sandbox (401 token.sandbox_refused) unless it opted in to sandbox tokens. Absent on first-party service tokens, which are production.
   */
  env?: "sandbox" | "production";
  /**
   * The person who authorized an app through the authorization-code flow. Absent on client_credentials tokens.
   */
  on_behalf_of?: string;
  [k: string]: unknown | undefined;
};

/** common.entity-ref@1.0.0 (owner: contracts) */
/**
 * Typed reference to another service's entity. Store this instead of a foreign key; resolve a display projection from the owner.
 */
export interface EntityRef {
  service: string;
  type: string;
  id: string;
  revision?: number;
  /**
   * Cached display label. Never authoritative.
   */
  label?: string;
}

/** errors.problem@1.0.0 (owner: contracts) */
/**
 * RFC 9457 problem details (application/problem+json) with a stable OpenVibe error code and trace identifiers. The legacy 'error' string is allowed during migration so existing clients keep working.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  request_id?: string;
  trace_id?: string;
  errors?: {
    path?: string;
    message: string;
  }[];
  /**
   * Deprecated compatibility field: same text as title/detail for clients that read {error}.
   */
  error?: string;
  [k: string]: unknown | undefined;
}

/** registry.service-manifest@1.0.0 (owner: network) */
/**
 * What a service is, where it lives and what it offers. The ecosystem registry is built from these, not from hard-coded route maps.
 */
export interface ServiceManifest {
  id: string;
  name?: string;
  version: string;
  status: "placeholder" | "alpha" | "beta" | "stable" | "degraded" | "retired";
  repository: string;
  domains: string[];
  publicOrigin?: string;
  health?: string;
  ready?: string;
  capabilities: string[];
  eventsProduced: string[];
  eventsConsumed: string[];
  namespacesOwned: string[];
  contractRanges?: {
    [k: string]: string | undefined;
  };
  notes?: string;
}

/** capabilities.capability@1.0.0 (owner: network) */
/**
 * An action a principal may invoke. Authorization is checked at the owner's boundary against the grant, never inferred from the caller's route.
 */
export interface Capability {
  id: string;
  version: string;
  owner: string;
  status: "planned" | "active" | "deprecated" | "retired";
  visibility: "public" | "partner" | "first-party" | "internal";
  description?: string;
  inputSchema?: string;
  outputSchema?: string;
  permissions: string[];
  resourceConstraints: ("namespace" | "owner" | "room_member" | "space_member" | "project" | "none")[];
  quotaClass: string;
  events: string[];
  /**
   * Current route(s) that perform this action today, e.g. 'POST /api/v1/:app/files'.
   */
  implementedBy?: string[];
}

/** events.event-envelope@1.0.0 (owner: events) */
/**
 * Durable platform event (OpenVibe.Events, Wave 3). Producers write it to an outbox in the same transaction as the domain change.
 */
export interface EventEnvelope {
  event_id: string;
  trace_id?: string;
  event_type: string;
  version: number;
  source: string;
  actor: SubjectRef;
  timestamp: string;
  priority?: "critical" | "important" | "low";
  visibility?: "public" | "subject" | "internal";
  subject: {
    type: string;
    id: string;
    revision?: number;
  };
  payload: {};
}

/** modules.namespace@1.0.0 (owner: network) */
/**
 * Policy for one user-module namespace: portable per-subject summaries and preferences stored by OpenVibe.Network. Never domain truth, money or authoritative game inventory (roadmap 4.3-4.5).
 */
export interface ModuleNamespace {
  namespace: string;
  /**
   * Service that owns the namespace and may write it with network.modules.write.
   */
  owner: string;
  /**
   * Schema version stored with every record; a change needs a migration note.
   */
  version: number;
  description?: string;
  /**
   * JSON Schema (2020-12) every stored value must satisfy.
   */
  schema: {};
  /**
   * owner = the owning service with a token; user = the subject themselves.
   *
   * @minItems 1
   */
  writers: ["owner" | "user", ...("owner" | "user")[]];
  /**
   * Top-level fields anyone may read. Everything else is readable only by the subject and granted services.
   */
  publicFields: string[];
  quotaBytes: number;
  /**
   * What happens to records when the owning service or mod is retired.
   */
  onOwnerRemoved: "retain-readonly" | "delete-after-retention";
  retentionDays?: number;
  /**
   * How records of the previous version are upgraded.
   */
  migration?: string;
}

/** modules.module-record@1.0.0 (owner: network) */
/**
 * One subject's value in one namespace, as returned by Network. revision increases by one on every write; a write names the revision it read (If-Match) and fails with 412 if it moved.
 */
export interface ModuleRecord {
  subject: SubjectRef;
  namespace: string;
  version: number;
  revision: number;
  data: {};
  updated_at: string;
  /**
   * user:<subject> or svc:<service>
   */
  updated_by?: string;
}
