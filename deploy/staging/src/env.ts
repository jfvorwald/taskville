// The Worker's bindings and the few platform shapes it touches, declared structurally so the
// package needs no Workers type package. Fakes with the same shapes stand in for them off-platform.

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: never): DurableObjectStubLike;
}

export interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(): Promise<Map<string, T>>;
  };
}

export interface Env {
  /** The frozen web client of the release (`dist`, filled by the M7.02 release step). */
  ASSETS: AssetsBinding;
  /** The pairing store: one Durable Object holding codes and sessions. */
  PAIRING: DurableObjectNamespaceLike;
  RELEASE_ID: string;
  RELEASE_VERSION: string;
  APP_ENV: string;
  /** `<team>.cloudflareaccess.com`: where the Access signing keys live. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience tag. */
  ACCESS_AUD?: string;
}

/** Who Access says is signed in. */
export interface AccessIdentity {
  email: string;
}

/** Checks the `Cf-Access-Jwt-Assertion` value; null when it does not verify. */
export type VerifyAccess = (jwt: string, env: Env) => Promise<AccessIdentity | null>;
