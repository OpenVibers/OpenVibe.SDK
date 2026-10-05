/* Copied verbatim from openvibe-contracts v0.86.0 generated/typescript/index.d.ts (the SDK does not
 * require the package at runtime; it is a devDependency for the tests). test/types.test.js checks
 * these against it. */
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
    }
  | {
      type: "agent";
      id: string;
    };

/** identity.service-token-claims@1.3.0 (owner: network) */
/**
 * Claims of a short-lived RS256 client-credentials token issued by OpenVibe.Network to a service, app, mod, node or agent principal. Replaces X-Internal-Key. App tokens (actor_type app) also carry project_id and env; receivers refuse env=sandbox unless they opted in. Agent tokens (actor_type agent, sub agent:agt_<ULID>) are minted for the agent's host and also carry project_id, env and on_behalf_of (the owner), and optionally cap_confirm and act.
 */
export type ServiceTokenClaims = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Issuer; https://openvibe.network in production. Receivers pass the issuer they expect to verifyServiceToken().
   */
  iss: string;
  sub: string;
  actor_type: "service" | "app" | "mod" | "node" | "agent";
  /**
   * @minItems 1
   */
  aud: [string, ...string[]];
  /**
   * Granted capability ids; a trailing .* grants a family.
   */
  cap: string[];
  /**
   * Agent tokens: capabilities the agent holds in confirm mode. Each use needs an approved network.confirmation-request@1, presented as OpenVibe-Confirmation: cnf_<ULID> and consumed by the owning service. Never also in cap, so a receiver that does not know agents refuses those actions.
   */
  cap_confirm?: string[];
  /**
   * Namespace constraints, e.g. live.* or mod.example.*. A developer app token carries its project_id (the whole project, as issued before namespaces were rows) and app.<project_id>.*: on Media, app.<project_id> and app.<project_id>.sandbox are the project's production and sandbox namespaces, with children below them.
   */
  ns?: string[];
  iat: number;
  exp: number;
  jti: string;
  /**
   * Developer project of an app or agent principal (ADR-014). Services key tenancy by it. Absent on first-party service tokens.
   */
  project_id?: string;
  /**
   * Environment of an app or agent principal. A receiver MUST refuse env=sandbox (401 token.sandbox_refused) unless it opted in to sandbox tokens. Absent on first-party service tokens, which are production.
   */
  env?: "sandbox" | "production";
  /**
   * The person who authorized an app through the authorization-code flow, or the owner an agent acts for (always present on agent tokens). Absent on client_credentials tokens.
   */
  on_behalf_of?: string;
  /**
   * Agent tokens: the host that runs the agent and the token was minted for (RFC 8693 actor claim), a service or an app.
   */
  act?: {
    sub: string;
  };
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

/** registry.service-manifest@1.1.0 (owner: network) */
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
  /**
   * Where the service answers on its host (loopback only): the address the registry polls health and readiness from. A host inventory or an OV_<ID>_INTERNAL_URL loopback override may replace it; a service with nothing to run has none.
   */
  internalOrigin?: string;
  /**
   * Where the service can actually be reached today, which is separate from its maturity (status): live (its public domain serves it), internal (loopback only; the domain, if any, still serves a placeholder), library (a released package), repository (code with CI, nothing released or run), placeholder (charter only) or retired. When a service goes public, this changes in the same release that points its domain at it.
   */
  exposure?: {
    state: "live" | "internal" | "library" | "repository" | "placeholder" | "retired";
    /**
     * What the public domain answers today: the service itself, a placeholder page, or nothing (no public domain).
     */
    publicSite?: "service" | "placeholder" | null;
    note?: string;
    /**
     * For a library: the npm package name.
     */
    package?: string;
    /**
     * For a library: the OpenVibers repository its release tags live in.
     */
    repo?: string;
  };
  /**
   * How the network presents the service as a site people visit (the navigation, the network home page, legal pages). A service without it is not a site. 1.1.0 (plan T11 lane D) adds the optional showcase fields copied from the OpenVibe.Sites catalog (tld, accent, description, pillars, faq, keywords, vision, highlight, launch, relationships; defined in registry.product@1): a site carrying tld is the catalog home of its domain (its publicOrigin host, or host), so that domain has no manifests/products file.
   */
  site?: {
    /**
     * Short name after 'OpenVibe.' (or a full name containing a dot).
     */
    name: string;
    icon: string;
    tagline: string;
    what: string;
    /**
     * Which legal wording its /terms, /privacy and /dmca use (openvibe-shared/legal).
     */
    legalProfile: "streaming" | "tools" | "ugc" | "games" | "hosting" | "account" | "info";
    /**
     * Order in site lists.
     */
    position?: number;
    /**
     * Only while the manifest has no publicOrigin.
     */
    host?: string;
    /**
     * The product's short name used everywhere (frame service names, /shared paths), e.g. food for openvibe.food. Not unique: a moved product keeps it on both addresses.
     */
    tld?: string;
    /**
     * Brand colour, lower-case hex.
     */
    accent?: string;
    /**
     * The catalog's description, verbatim.
     */
    description?: string;
    /**
     * Feature pillars, in display order.
     *
     * @maxItems 8
     */
    pillars?:
      | []
      | [
          {
            title: string;
            text: string;
          }
        ]
      | [
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          }
        ]
      | [
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          }
        ]
      | [
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          }
        ]
      | [
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          }
        ]
      | [
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          }
        ]
      | [
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          }
        ]
      | [
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          },
          {
            title: string;
            text: string;
          }
        ];
    /**
     * @maxItems 20
     */
    faq?:
      | []
      | [
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ]
      | [
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          },
          {
            question: string;
            answer: string;
          }
        ];
    /**
     * Comma-separated search keywords, verbatim.
     */
    keywords?: string;
    /**
     * The product page's vision section (badge, call to action, design preview, steps, choices, features, connections), kept verbatim from the catalog: a presentation payload the showcase renders as it is, not a domain contract.
     */
    vision?: {
      [k: string]: unknown | undefined;
    };
    /**
     * A featured block on the product page.
     */
    highlight?: {
      title: string;
      text: string;
      /**
       * @maxItems 10
       */
      points?:
        | []
        | [string]
        | [string, string]
        | [string, string, string]
        | [string, string, string, string]
        | [string, string, string, string, string]
        | [string, string, string, string, string, string]
        | [string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string, string];
      cta?: {
        label: string;
        url: string;
        note?: string;
      };
      more?: {
        label: string;
        url: string;
        note?: string;
      };
    };
    /**
     * What a person still has to do or decide before the product launches. Absent once nothing blocks it.
     */
    launch?: string;
    /**
     * How the product relates to services, repositories and other pages.
     */
    relationships?: {
      /**
       * The service manifest (manifests/services/<id>.json) that serves or will serve this product, when one exists.
       */
      service?: string;
      /**
       * The repository planned or used for the product (under github.com/OpenVibers).
       */
      plannedRepo?: string;
      /**
       * No repository exists for the product yet.
       */
      noRepo?: true;
      /**
       * The sentence introducing links.
       */
      linksLead?: string;
      /**
       * Where to go instead (a closed, moved or status address).
       *
       * @maxItems 10
       */
      links?:
        | []
        | [
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ];
      /**
       * What already works elsewhere on the network while the product is not launched.
       *
       * @maxItems 10
       */
      meanwhile?:
        | []
        | [
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ]
        | [
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            },
            {
              label: string;
              url: string;
              note?: string;
            }
          ];
      /**
       * The status API a status page reads.
       */
      statusApi?: string;
    };
  };
  capabilities: string[];
  eventsProduced: string[];
  eventsConsumed: string[];
  namespacesOwned: string[];
  contractRanges?: {
    [k: string]: string | undefined;
  };
  /**
   * How the service starts, stops, recovers and is rolled back (roadmap WS-P task 1), taken from its code and its systemd units, never from intent. A part that does not apply is { "none": "<why>" }. `ovhost validate` refuses a host service whose lifecycle lacks a field, whose shutdown deadline exceeds its unit's TimeoutStopSec, or whose installed openvibe-contracts is outside contracts.range.
   */
  lifecycle?: {
    /**
     * The endpoint that says the process is alive, and what a 200 from it proves. Readiness (can it serve?) is `ready`.
     */
    liveness:
      | {
          /**
           * A path on internalOrigin; the same as `health`.
           */
          endpoint: string;
          /**
           * What a 200 proves, and what it does not check.
           */
          means: string;
        }
      | {
          /**
           * Why there is none.
           */
          none: string;
        };
    /**
     * What happens between the stop signal and the process exiting.
     */
    shutdown:
      | {
          /**
           * The signal the unit sends (KillSignal=, systemd's default SIGTERM) and the process handles.
           */
          signal: "SIGTERM" | "SIGINT" | "SIGQUIT" | "SIGHUP";
          /**
           * The longest the process takes from the signal to exiting, as its own code bounds it (a forced-exit timer); 0 when it exits at once. Must not exceed the unit's TimeoutStopSec, after which systemd kills it mid-drain.
           */
          deadlineSeconds: number;
          /**
           * What it stops, finishes, flushes or closes before exiting, in order.
           *
           * @minItems 1
           */
          drains: [string, ...string[]];
          /**
           * Worker units the service owns that drain on their own (ovhost never restarts them): how long a stop signal lets them run.
           */
          workers?: {
            /**
             * The longest a worker keeps running after the stop signal, as its code bounds it.
             */
            deadlineSeconds: number;
            /**
             * What a worker keeps serving, and what it ends, before exiting.
             *
             * @minItems 1
             */
            drains: [string, ...string[]];
          };
          /**
           * Anything the fields above do not say (a gap the code has, a handler that is missing).
           */
          note?: string;
        }
      | {
          /**
           * Why there is none.
           */
          none: string;
        };
    /**
     * Work a stop or a crash interrupted that the next start picks up.
     */
    startupRecovery:
      | {
          /**
           * Each thing the process resumes at boot.
           *
           * @minItems 1
           */
          resumes: [
            {
              /**
               * outbox: unsent events; jobs: queued or interrupted background work; sessions: client connections or media sessions; consumer: an event or change feed redelivered or read from a stored cursor; schedule: timed work that fell due; state: in-memory state rebuilt from storage.
               */
              kind: "outbox" | "jobs" | "sessions" | "consumer" | "schedule" | "state";
              /**
               * What is resumed, and how.
               */
              what: string;
            },
            ...{
              /**
               * outbox: unsent events; jobs: queued or interrupted background work; sessions: client connections or media sessions; consumer: an event or change feed redelivered or read from a stored cursor; schedule: timed work that fell due; state: in-memory state rebuilt from storage.
               */
              kind: "outbox" | "jobs" | "sessions" | "consumer" | "schedule" | "state";
              /**
               * What is resumed, and how.
               */
              what: string;
            }[]
          ];
        }
      | {
          /**
           * Why there is none.
           */
          none: string;
        };
    /**
     * When a release is rolled back, for how long that happens by itself, and what makes going back unsafe.
     */
    rollback:
      | {
          /**
           * What triggers a rollback: automatic (readiness not reached after the restart) and manual.
           *
           * @minItems 1
           */
          conditions: [string, ...string[]];
          /**
           * How long after a deploy the rollback is automatic, and what bounds a manual one.
           */
          window: string;
          /**
           * Changes a previous release cannot live with (forward-only migrations, table rebuilds, authority switches), or { none } with the reason.
           */
          blockers:
            | [string, ...string[]]
            | {
                /**
                 * Why there is none.
                 */
                none: string;
              };
        }
      | {
          /**
           * Why there is none.
           */
          none: string;
        };
    /**
     * The openvibe-contracts versions the service accepts.
     */
    contracts:
      | {
          /**
           * The accepted versions, the same range as contractRanges['openvibe-contracts'].
           */
          range: string;
          /**
           * Where the range comes from, when it is not the obvious one.
           */
          note?: string;
        }
      | {
          /**
           * Why there is none.
           */
          none: string;
        };
    /**
     * What the service claims so that one owner acts at a time, and how a stale owner is fenced.
     */
    leases:
      | {
          /**
           * Each thing claimed, with its holder, expiry and fencing.
           *
           * @minItems 1
           */
          claims: [
            {
              /**
               * What is claimed.
               */
              what: string;
              /**
               * Who holds the claim (a process, a worker id, a row).
               */
              holder: string;
              /**
               * When the claim lapses and how it is renewed.
               */
              expires: string;
              /**
               * How a stale owner is kept from acting after its claim lapsed.
               */
              fencing: string;
            },
            ...{
              /**
               * What is claimed.
               */
              what: string;
              /**
               * Who holds the claim (a process, a worker id, a row).
               */
              holder: string;
              /**
               * When the claim lapses and how it is renewed.
               */
              expires: string;
              /**
               * How a stale owner is kept from acting after its claim lapsed.
               */
              fencing: string;
            }[]
          ];
        }
      | {
          /**
           * Why there is none.
           */
          none: string;
        };
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
  /**
   * The action has an external side effect (money, sending as the person, publishing, applying, deleting, physical control): an agent needs its owner's confirmation unless a standing rule covers it (roadmap WS-Z2).
   */
  sensitive?: boolean;
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
  on_behalf_of?: SubjectRef;
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
 * Policy for one user-module namespace: portable per-subject summaries and preferences stored by OpenVibe.Network. Never domain truth, money or authoritative game inventory (roadmap 4.3-4.5). The person's account decides what happens to their records in every namespace: when an account is removed, Network deletes all of its records; when two accounts are merged (ADR-029), in a namespace where both have a record the survivor keeps its own and gains only the top-level fields it lacks from the other (its own values always win), a record only the absorbed account had moves to the survivor, and the absorbed account's records are deleted. Each of these changes is announced as network.module.updated (reason subject_removed or subject_merged). That is separate from onOwnerRemoved, which says what happens to a namespace's records when the service that owns the namespace is retired.
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
  /**
   * Field-level read rules: a service other than the owner, holding network.modules.read for the namespace, sees publicFields plus the fields listed for it here, and nothing else. A service not listed sees publicFields only. The owner and the person always see the whole record.
   */
  readers?: {
    [k: string]: string[] | undefined;
  };
  /**
   * Declarative upgrades from each earlier version, applied in order when a stored record's version is below the namespace's: rename moves a field, drop removes fields, defaults adds fields the record lacks. Network upgrades a record when it is read and stores the upgraded record on its next write.
   */
  migrations?: {
    from: number;
    to: number;
    rename?: {
      [k: string]: string | undefined;
    };
    drop?: string[];
    defaults?: {};
  }[];
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

/** codes.app-manifest@1.0.0 (owner: codes) */
/**
 * PROPOSAL (OpenVibe.Codes, roadmap Wave 20): an app release as the platform knows it. The app is a Network developer app (ADR-014): its id is the Network app id, its capabilities are only a request (the grants in Network are the authority), and trust tiers are metadata that never change a grant check. OpenVibe.Codes validates with this schema, loaded into openvibe-contracts' validator, until Contracts publishes it as codes.app-manifest@1.
 */
export interface AppManifest {
  /**
   * The Network app id (its client_id). Its principal subject is app:<id>.
   */
  id: string;
  name: string;
  /**
   * Semantic version of this release.
   */
  version: string;
  description?: string;
  publisher: SubjectRef;
  /**
   * The Network project that owns the app. Tenancy in other services is keyed by it (ADR-014).
   */
  project_id: string;
  /**
   * The app's environment. Apps never change environment.
   */
  environment?: "sandbox" | "production";
  /**
   * Capability ids the app asks for (3+ segments). Only active public (or partner, by staff allowance) capabilities can ever be granted to apps.
   *
   * @maxItems 64
   */
  capabilities: string[];
  events?: {
    /**
     * Event types (or a trailing .* family) the app subscribes to.
     *
     * @maxItems 64
     */
    consumes?: string[];
  };
  /**
   * Informational copy of the redirect URIs registered in Network (Network's list is the authority).
   *
   * @maxItems 10
   */
  redirect_uris?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  homepage?: string;
  repository?: string;
  /**
   * SPDX license expression.
   */
  license?: string;
  compatibility: {
    /**
     * Semver range of openvibe-contracts releases it was built against.
     */
    contracts: string;
    /**
     * Semver range of openvibe-sdk releases it uses.
     */
    sdk?: string;
  };
}

/** tools.tool@1.1.0 (owner: tools) */
/**
 * One tool on openvibe.tools as its registry describes it (GET /api/v1/tools/:id, and each item of GET /api/v1/tools; capability tools.tool.read; ADR-027). There is one descriptor per catalogue tool (GET /api/catalog.json tools[].id), built from the tool's own code, so its page, the run API, openvibe-sdk/tools, the OpenAPI document and the docs all read the same facts. EXECUTION is where the tool's engine runs for its page: client (in the browser; nothing leaves it), sync (a server request answered inline) or job (an asynchronous job on a satellite, tools.job@1). API says whether POST /api/v1/tools/{id}/run exposes the tool. A client tool has api true only when it also has a server engine (a pure transform that runs in Node), and its page stays browser-only. A page-only tool (yt) has api false and run null. A job tool's run creates a job of run.job.type whose input is { ...input, ...run.job.preset, tool: run.job.operation } (the preset and the operation always win). INPUT is the JSON Schema (2020-12) that a run request's input must match, embedded or as { $ref: https://openvibe.tools/api/v1/tools/{id}/schema#/$defs/input }. GET /api/v1/tools/:id/schema answers { $schema, $id, $defs: { input, output } }, and the list uses the $ref form. When api is false, $defs.input is false (the schema that accepts nothing), since there is no run to take an input. OUTPUT.SCHEMA describes result.data for every execution: inline and job tools alike. KEYWORDS (the catalogue's search terms) and EXAMPLES (sample runs for the docs and the OpenAPI document) are optional. NOT A TOOL: there is no planned status. A planned catalogue entry has no descriptor and is not listed, and neither is a mirror (a second build of another tool). GET /api/v1/tools/:id and /schema answer 404 tools.tool.not_found for either, with a detail that says the id is planned or names the tool it mirrors, as for an id that does not exist. RULES this schema enforces: api false has no run and no examples, and api true has a run and an input; an API job tool names its job, and only job tools name one; an API tool whose output is a file runs as a job (its results are served as job files); a tools.net.probe tool fetches (egress) and is never anonymous; an anonymous egress tool has a per-target throttle (limits.perTargetPerMinute); a client tool never fetches; an unavailable tool says why (statusReason); JSON output has a schema. contracts.tools.checkDescriptor(d) also checks what depends on the id (run.path, $ref targets), files.min <= files.max, and each example: its input against an embedded input schema and limits.maxInputBytes, and its files against files (count and accept).
 */
export interface ToolDescriptor {
  /**
   * The tool's catalogue id, which is its subdomain label (png, jsminify, dns, pdf2jpg). It never changes.
   */
  id: string;
  /**
   * The catalogue family: net, dev, img, audio, docs, text, media, places, pastes…
   */
  family: string;
  name: string;
  /**
   * One plain sentence: what the tool does.
   */
  summary: string;
  /**
   * Optional. The catalogue's search terms for the tool (GET /api/catalog.json tools[].keywords): phrases people search for, such as 'heic to png' or 'yaml validator'. GET /api/v1/tools?q= matches every word of the query against the id, name, summary and these.
   *
   * @maxItems 50
   */
  keywords?: string[];
  /**
   * stable: works, and its input and output only grow. beta: works; input or output may still change in a minor. preview: works with known gaps (limits or output not final). unavailable: listed, but runs are refused with 503 tools.tool.unavailable and the page says so (statusReason); a program or upstream the engine needs is missing (qpdf, pdftoppm, heif-dec, ffmpeg…), and the engine's own routes answer 503 tools.unavailable while it is. There is no planned status: a planned catalogue entry is not a tool, so it has no descriptor and is not listed.
   */
  status: "stable" | "beta" | "preview" | "unavailable";
  /**
   * Why the status is what it is, for people (e.g. 'needs qpdf on the host'). Required when unavailable.
   */
  statusReason?: string;
  /**
   * Where the engine runs for the tool's page: client (the browser), sync (a server request answered inline), job (an asynchronous job).
   */
  execution: "client" | "sync" | "job";
  /**
   * POST /api/v1/tools/{id}/run exposes the tool. false for a client tool without a server engine and for page-only tools (yt).
   */
  api: boolean;
  /**
   * How to call it; null when api is false.
   */
  run: {
    method: "POST";
    /**
     * /api/v1/tools/{id}/run on https://openvibe.tools; the body is tools.run-request@1, the answer tools.run@1.
     */
    path: string;
    /**
     * For a job tool: the job the run creates. null for tools answered inline.
     */
    job: {
      /**
       * Job type, e.g. img.process.
       */
      type: string;
      /**
       * The job input's tool field: convert, compress, trim, mergepdf…
       */
      operation: string;
      /**
       * Input fields the tool itself fixes, applied over the caller's input (png: { format: png }).
       */
      preset?: {};
    } | null;
    /**
     * Older routes that run the same engine (GET /api/net/dns/:target, POST /api/process…). They keep working until their Sunset date and answer with Deprecation, Sunset and Link: rel=successor-version pointing at path.
     *
     * @maxItems 32
     */
    legacy?: string[];
  } | null;
  /**
   * JSON Schema (2020-12) of the run request's input: embedded (an object schema), or { $ref } to $defs/input of GET /api/v1/tools/:id/schema. null only for a tool without an API, whose $defs/input is false (it accepts nothing).
   */
  input:
    | {
        $ref: string;
      }
    | {
        type: "object";
      }
    | null;
  /**
   * The files a run takes (multipart parts, or tools.run-request@1 files references); null when it takes none.
   */
  files: {
    min: number;
    max: number;
    /**
     * Accepted media types, checked against the bytes, not the client's Content-Type (image/png, image/*, application/pdf…).
     *
     * @minItems 1
     */
    accept: [string, ...string[]];
    /**
     * Largest accepted file.
     */
    maxBytes: number;
  } | null;
  /**
   * Optional. Sample runs, which the docs and the generated OpenAPI document publish. Each example's input is valid against the tool's input schema and fits limits.maxInputBytes, and its files fit files (count and accept); contracts.tools.checkDescriptor checks this whenever input is embedded. Only a tool with an API has examples.
   *
   * @maxItems 50
   */
  examples?: {
    /**
     * What the example shows, for people.
     */
    title?: string;
    /**
     * A run request's input (tools.run-request@1 input), valid against the tool's input schema.
     */
    input: {};
    /**
     * The files the sample run takes (uploaded parts or files references), in order: what each one is, and where to download a sample.
     *
     * @maxItems 100
     */
    files?: {
      /**
       * A file name for the sample (photo.jpg).
       */
      name?: string;
      /**
       * Its media type, one that files.accept allows.
       */
      mime: string;
      /**
       * A sample file to download.
       */
      url?: string;
    }[];
  }[];
  output: {
    /**
     * json: result.data; text: result.text; file or files: result.files (job result files).
     */
    kind: "json" | "file" | "files" | "text";
    /**
     * JSON Schema of result.data, whatever the execution: for a job tool too, where it describes the data of the run's result and of its job's result (tools.job@1 result.data), which are the same object. Required when kind is json. Embedded, or { $ref } to $defs/output of GET /api/v1/tools/:id/schema.
     */
    schema?:
      | {
          $ref: string;
        }
      | {
          type: "object";
        };
    /**
     * Media types the result files can have (kind file or files).
     *
     * @minItems 1
     */
    mime?: [string, ...string[]];
  };
  limits: {
    /**
     * A run (or its job) longer than this fails with tools.job.timeout or 504.
     */
    timeoutMs: number;
    /**
     * Longest audio or video input.
     */
    maxDurationSec?: number;
    /**
     * Largest image input (width × height).
     */
    maxPixels?: number;
    /**
     * Most PDF pages. A longer document fails with 413 tools.pdf.too_many_pages.
     */
    maxPages?: number;
    /**
     * Largest input as JSON (text to transform, lists of hosts…).
     */
    maxInputBytes?: number;
    /**
     * Egress tools: most runs per minute against one target host or address, across all callers.
     */
    perTargetPerMinute?: number;
  };
  /**
   * Caller tiers: anonymous < session < user < app/service.
   */
  auth: {
    /**
     * true: a caller with no token and no browser session may run it (keyed by IP, IPv6 by /64). false: a browser session (the ov_tools_jobs cookie), a signed-in person or a token is needed.
     */
    anonymous: boolean;
    /**
     * What an app or service token must hold. tools.tool.run is public. tools.net.probe (partner) covers network probes: only principals holding it run these through the API; people use their pages, which have a per-target throttle.
     */
    capability: "tools.tool.run" | "tools.net.probe";
  };
  /**
   * The quota bucket a run counts against, with allowances per caller tier. Names describe the work, never a tier or a price (tools-run, tools-job, tools-probe, tools-fetch…), so a paid tier later adds allowances, not names. A caller whose allowance is spent gets 429 tools.quota.exceeded with Retry-After.
   */
  quotaClass: string;
  /**
   * Relative weight of one run within its quota class (1 = a cheap lookup or transform). Quotas count weight, not requests.
   */
  cost: number;
  /**
   * The server fetches a host or URL the caller chose (DNS, WHOIS, headers, Open Graph, ports…), always through the SSRF guard.
   */
  egress: boolean;
  /**
   * The tool's public hostnames, canonical first (png.openvibe.tools, a custom domain…); empty for a tool that lives on another service.
   *
   * @maxItems 50
   */
  hosts: string[];
  /**
   * Where a person reads about the tool.
   */
  docs: string;
}

/** tools.tool-list@1.0.0 (owner: tools) */
/**
 * The answer of GET /api/v1/tools on openvibe.tools (capability tools.tool.read; ADR-027): every tool's descriptor (tools.tool@1), with input and output schemas in the { $ref } form (GET /api/v1/tools/:id has them embedded). Filters: ?family=, ?execution=client|sync|job, ?api=true|false, ?status=, ?q= (every word must appear in the id, name, summary or keywords); family, execution and status take comma lists. An unknown execution or status value, or an api that is not true or false, is 400 tools.query.invalid. Every listed tool has one of the descriptor's statuses: there is no planned status, so planned placeholders are not tools and are not listed, and neither are mirrors (GET /api/v1/tools/:id answers 404 tools.tool.not_found for both, with a detail saying why). Cacheable (ETag); updated_at changes when any descriptor does.
 */
export interface ToolList {
  tools: ToolDescriptor[];
  /**
   * The number of tools in this answer.
   */
  count: number;
  updated_at: string;
  /**
   * The families of the tools in this answer.
   */
  families?: {
    id: string;
    name: string;
    count: number;
  }[];
}

/** tools.run-request@1.0.0 (owner: tools) */
/**
 * Body of POST /api/v1/tools/{id}/run on openvibe.tools (capability tools.tool.run, or tools.net.probe for network probes; ADR-027). JSON, or multipart/form-data like POST /api/v1/jobs: the text parts input (JSON text), wait_ms and idempotency_key, and uploaded files as file or files parts. The tool gets the uploaded files first, then the files references, in order; the count must fit the descriptor's files.min and files.max. input must match the tool's input schema (tools.tool@1 input). A job tool's job input is { ...input, ...run.job.preset, tool: run.job.operation } (the preset and the operation always win). The Idempotency-Key header wins over idempotency_key; ?wait_ms= on the query does the same as the field. Answers tools.run@1: 200 finished (succeeded, or failed with the tool's own error), 202 + Location while a job is queued or running, 200 + Idempotent-Replayed: true for a replay. Refusals are problem+json: 400 tools.run.invalid (not JSON, a bad field, wrong file count), 401 token.*, 403 capability.denied, 404 tools.tool.not_found, 404 tools.tool.not_runnable (api false: a page-only tool), 404 tools.run.file_not_found (a reference the caller cannot read), 409 tools.job.idempotency_conflict, 413 tools.file.too_large, 415 tools.file.unsupported_type (checked against the bytes), 422 tools.input.invalid (errors[] with JSON pointers), 429 tools.quota.exceeded (Retry-After; the caller's allowance in the tool's quota class is spent), quota.exceeded or tools.job.too_many_active (Retry-After), 503 tools.tool.unavailable (the descriptor's status is unavailable), 503 tools.unavailable (a program or upstream the tool needs is missing), 503 tools.busy (Retry-After; every slot for this kind of work is taken). A job tool's own refusals (413 tools.pdf.too_many_pages, 422 tools.pdf.wrong_password…) come back as a failed run (tools.run@1 error).
 */
export interface ToolsRunRequest {
  /**
   * The tool's parameters, matching its input schema. Default {}.
   */
  input?: {};
  /**
   * Files that are already somewhere, instead of or besides uploaded parts.
   *
   * @maxItems 50
   */
  files?: (
    | {
        media_id: string;
      }
    | {
        job_id: string;
        index: number;
      }
  )[];
  /**
   * Job tools: wait up to this long for the job to finish before answering (200 finished, else 202 with the job). Default 0. Inline tools always answer finished.
   */
  wait_ms?: number;
  /**
   * Job tools: the same (caller, key) and request returns the same job; a different request under it is 409 tools.job.idempotency_conflict. Inline tools ignore it.
   */
  idempotency_key?: string;
}

/** tools.run@1.0.0 (owner: tools) */
/**
 * The answer of POST /api/v1/tools/{id}/run (tools.run-request@1; ADR-027). Finished: { state: succeeded, tool, result, took_ms } or { state: failed|cancelled, tool, error, took_ms }, with job set when the tool ran as a job. Not finished within wait_ms: { state: queued|running, tool, job, location }, sent with 202 and a Location header; follow the job there (GET, its events, its files; tools.job@1). result carries data (kind json, matching the descriptor's output schema), text (kind text) or files (kind file or files: the job's result files, downloaded from their url). took_ms runs from the request to the answer for an inline run, and from created_at to finished_at for a job. error is problem+json from the tool: tools.job.failed, tools.job.timeout, tools.job.cancelled, or a code the tool chose (tools.…), such as 413 tools.pdf.too_many_pages or 422 tools.pdf.wrong_password; its status is the problem's, not the HTTP answer's. A request refused before the tool ran is a problem+json answer, not a run. Also: 413 tools.input.too_large (the input exceeded a worker's memory or size limit), 504 tools.run.timeout (the run passed the descriptor's timeoutMs), 403 tools.origin.refused (a cookie-authenticated mutation from a foreign Origin), 401 tools.session_required (the tool is not anonymous and the call has no browser session or token), 404 tools.run.file_not_found (a files reference names no result the caller may read), 500 tools.run.failed (the engine failed without a more specific code).
 */
export type ToolsRun =
  | {
      state: "succeeded";
      tool: string;
      result: {
        /**
         * Output data; matches the descriptor's output.schema when output.kind is json.
         */
        data?: {};
        /**
         * Output text (output.kind text).
         */
        text?: string;
        /**
         * Result files (output.kind file or files), exactly as the job lists them.
         *
         * @maxItems 100
         */
        files?: {
          name: string;
          mime: string;
          size: number;
          sha256: string;
          /**
           * media: a private OpenVibe.Media object (TOOLS_JOB_RESULTS=media); local: kept on the satellite until the job expires.
           */
          storage: "local" | "media";
          /**
           * The Media object, when storage is media.
           */
          media: {
            media_id: string;
            role?: string;
            namespace?: string;
            size_bytes?: number;
            content_hash?: string;
            mime_type?: string;
            /**
             * The object's Media lifecycle status when it was stored (ready).
             */
            status?: string;
          } | null;
          /**
           * Present when storing the file in Media failed; the file stayed local.
           */
          media_error?: string;
          /**
           * Where the owner downloads it.
           */
          url: string;
        }[];
      };
      took_ms: number;
      job?: ToolsJob | null;
    }
  | {
      state: "failed" | "cancelled";
      tool: string;
      error: Problem;
      took_ms: number;
      job?: ToolsJob | null;
    }
  | {
      state: "queued" | "running";
      tool: string;
      job: ToolsJob;
      /**
       * The job (also the Location header): /api/v1/jobs/:id on the gateway.
       */
      location: string;
    };

/** tools.job@1.0.0 (owner: tools) */
/**
 * A Tools job as the jobs API answers it (OpenVibe.Tools apps/_shared/jobs/http.js, system.view; ADR-027): POST /api/v1/jobs (202 + Location, or 200 + Idempotent-Replayed: true), GET and DELETE /api/v1/jobs/:id, POST /api/v1/jobs/:id/retry, PUT and DELETE /api/v1/jobs/:id/references/:ref, the data of every SSE event on GET /api/v1/jobs/:id/events, and the job member of tools.run@1. A job is visible only to its owner (a person, a service/app principal, or one browser session); anyone else gets the same 404 tools.job.not_found as for a job that does not exist. result is null until the job succeeded; each result file is downloaded from its url (GET /api/v1/jobs/:id/files/:n, ?inline=1 for previews) and is stored as a private OpenVibe.Media object (storage media) or on the satellite until the job expires (storage local). expires_at is null while a reference keeps the result. error is problem+json: tools.job.failed, tools.job.timeout, tools.job.cancelled, or a code the tool chose (tools.…), such as 413 tools.pdf.too_many_pages or 422 tools.pdf.wrong_password, with server paths removed.
 */
export interface ToolsJob {
  id: string;
  object: "tools.job";
  /**
   * The Tools satellite that runs the job (img, audio, docs…).
   */
  service: string;
  /**
   * The tool (tools.tool@1 id) whose run created the job, when it came through POST /api/v1/tools/{id}/run. Absent for a job submitted to POST /api/v1/jobs directly.
   */
  tool?: string;
  /**
   * Job type, e.g. img.process.
   */
  type: string;
  type_version: number;
  /**
   * Terminal: succeeded, failed, cancelled.
   */
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: {
    percent: number | null;
    message: string | null;
  };
  attempts: number;
  max_attempts: number;
  /**
   * DELETE asked a running job to stop; it ends cancelled.
   */
  cancel_requested: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /**
   * When the job, its events and its result files are pruned; null while a reference keeps the result.
   */
  expires_at: string | null;
  result: {
    /**
     * @maxItems 100
     */
    files: {
      name: string;
      mime: string;
      size: number;
      sha256: string;
      /**
       * media: a private OpenVibe.Media object (TOOLS_JOB_RESULTS=media); local: kept on the satellite until the job expires.
       */
      storage: "local" | "media";
      /**
       * The Media object, when storage is media.
       */
      media: {
        media_id: string;
        role?: string;
        namespace?: string;
        size_bytes?: number;
        content_hash?: string;
        mime_type?: string;
        /**
         * The object's Media lifecycle status when it was stored (ready).
         */
        status?: string;
      } | null;
      /**
       * Present when storing the file in Media failed; the file stayed local.
       */
      media_error?: string;
      /**
       * Where the owner downloads it.
       */
      url: string;
    }[];
    /**
     * The tool's output data (dimensions, durations, page counts…); {} when it has none.
     */
    data: {};
  } | null;
  error: Problem | null;
  /**
   * Retrying may succeed (a timeout, a restart); POST links.retry makes a new job.
   */
  retryable: boolean;
  /**
   * The failed job this one retries.
   */
  retry_of: string | null;
  /**
   * The job that retried this failed one; asking again returns it.
   */
  retried_by: string | null;
  /**
   * What keeps the result (PUT /api/v1/jobs/:id/references/:ref), e.g. community:paste:p_123.
   *
   * @maxItems 50
   */
  references: {
    ref: string;
    created_at: string;
  }[];
  links: {
    self: string;
    events: string;
    /**
     * DELETE it while the job is queued or running.
     */
    cancel: string | null;
    /**
     * POST it when the job failed.
     */
    retry: string | null;
    retried_by: string | null;
  };
}

/** tools.job-request@1.0.0 (owner: tools) */
/**
 * Body of POST /api/v1/jobs on the Tools satellites that run jobs (img, audio, docs; capability tools.job.create; OpenVibe.Tools apps/_shared/jobs/http.js). JSON, or multipart/form-data with the same fields as text parts (input as JSON text) and the input files as file or files parts. The Idempotency-Key header wins over idempotency_key: the same (owner, key) and request returns the same job (200 + Idempotent-Replayed: true), a different request under it is 409 tools.job.idempotency_conflict. Types: img.process (input { tool: convert|compress|resize|crop, … }, one image), audio.process ({ tool, … } as /api/process takes them, one audio or video file), docs.process ({ tool, … }, one PDF, or several files for merge and img2pdf). A format host fills in its format (webp.openvibe.tools converts to WebP). Answers tools.job@1 (202 + Location). Refusals are problem+json: 400 tools.job.invalid (input not a JSON object or over 16 KB, wrong file count, the type's own validation) or tools.job.unknown_type, 401 token.* or tools.job.no_owner, 403 capability.denied, 413 tools.job.too_large, 429 tools.job.too_many_active (unfinished jobs per owner), tools.quota.exceeded (Retry-After; the owner's allowance is spent) or a rate limit, 503 tools.job.unavailable, 503 tools.unavailable (a program or upstream the job type needs is missing), 503 tools.busy (Retry-After; every slot for this kind of work is taken). A tool that refuses its input after the job was accepted fails the job with its own code (413 tools.pdf.too_many_pages, 422 tools.pdf.wrong_password…; tools.job@1 error).
 */
export interface ToolsJobRequest {
  /**
   * Job type: img.process, audio.process, docs.process.
   */
  type: string;
  /**
   * The job type's input; { tool: <operation>, …options }. Default {}; at most 16 KB as JSON.
   */
  input?: {};
  /**
   * 8-200 printable ASCII characters. The Idempotency-Key header is used when both are present.
   */
  idempotency_key?: string;
}
