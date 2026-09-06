/**
 * HTTP client for the dVeracity Semantic API + VaaS, with agent-friendly
 * error shaping. Kept free of MCP SDK imports so it is unit-testable.
 *
 * The 402 contract (see GET /api/v1/semantic/manifest): a body of
 * {error: "insufficient_credits", balance, needed, purchaseUrl} means the
 * account is out of credits — the agent should surface that to its human
 * operator rather than retrying.
 */

const DEFAULT_BASE_URL = 'https://dve-backend-xytsvgj3fq-ue.a.run.app';

export class SemanticApiError extends Error {
  constructor(message, { status, detail, actionable } = {}) {
    super(message);
    this.name = 'SemanticApiError';
    this.status = status;
    this.detail = detail;
    // Human-directed guidance the agent should relay verbatim.
    this.actionable = actionable;
  }
}

export class SemanticClient {
  constructor({ apiKey, baseUrl, fetchImpl, keriAid, keriPresentationPath, readFileImpl } = {}) {
    this.apiKey = apiKey || process.env.DVERACITY_API_KEY;
    this.baseUrl = (baseUrl || process.env.DVERACITY_API_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
    // Optional vLEI agent identity (design: elm/docs/VLEI_AGENT_TOKENS_DESIGN.md).
    // The API key still carries billing; the KERI session adds verified identity
    // (agent AID + Legal Entity LEI) to every metered call. Signify-based nonce
    // signing is a Phase 2 enhancement — the presentation itself authenticates.
    this.keriAid = keriAid || process.env.DVERACITY_KERI_AID || null;
    this.keriPresentationPath =
      keriPresentationPath || process.env.DVERACITY_KERI_PRESENTATION || null;
    this.readFile = readFileImpl || null; // lazy import of node:fs when needed
    this.keriSession = null; // { token, expiresAt, aid, lei, scopes, credentialSaid }
    if (!this.apiKey) {
      throw new SemanticApiError('DVERACITY_API_KEY is not set', {
        actionable:
          'Set the DVERACITY_API_KEY environment variable. Keys (dvrc_...) are created at ' +
          'POST /api/v1/api-keys and require an api-tier subscription — see https://dveracity.com/pricing.',
      });
    }
  }

  keriEnabled() {
    return Boolean(this.keriAid && this.keriPresentationPath);
  }

  async ensureKeriSession() {
    if (!this.keriEnabled()) return null;
    if (this.keriSession && this.keriSession.expiresAt - Date.now() > 60_000) {
      return this.keriSession;
    }
    if (!this.readFile) {
      const fs = await import('node:fs/promises');
      this.readFile = fs.readFile;
    }
    let presentation;
    try {
      presentation = await this.readFile(this.keriPresentationPath, 'utf8');
    } catch (err) {
      throw new SemanticApiError(`Cannot read KERI presentation: ${err.message}`, {
        actionable:
          'DVERACITY_KERI_PRESENTATION must point to a self-contained CESR export of the ' +
          "agent's dVeracity Agent Authorization credential.",
      });
    }
    const challenge = await this.rawRequest('GET', '/api/v1/semantic/auth/challenge');
    const session = await this.rawRequest('POST', '/api/v1/semantic/auth/keri', {
      aid: this.keriAid,
      nonce: challenge.nonce,
      presentation,
    });
    this.keriSession = {
      token: session.sessionToken,
      expiresAt: Date.now() + (session.expiresIn || 3600) * 1000,
      aid: session.aid,
      lei: session.lei,
      scopes: session.scopes,
      credentialSaid: session.credentialSaid,
    };
    return this.keriSession;
  }

  async request(method, path, body) {
    if (this.keriEnabled() && !path.startsWith('/api/v1/semantic/auth/')) {
      await this.ensureKeriSession();
      try {
        return await this.rawRequest(method, path, body);
      } catch (err) {
        // One re-auth retry if the KERI session was rejected (e.g. expired
        // between check and use, or the server rotated its secret).
        if (err.status === 401 && /keri session/i.test(err.message)) {
          this.keriSession = null;
          await this.ensureKeriSession();
          return this.rawRequest(method, path, body);
        }
        throw err;
      }
    }
    return this.rawRequest(method, path, body);
  }

  async rawRequest(method, path, body) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-Api-Key': this.apiKey,
          ...(this.keriSession?.token && !path.startsWith('/api/v1/semantic/auth/')
            ? { 'X-Keri-Session': this.keriSession.token }
            : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new SemanticApiError(`dVeracity API unreachable: ${err.message}`, { status: 0 });
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body — leave data null */
    }

    if (res.ok) return data;

    if (res.status === 402) {
      throw new SemanticApiError(
        `Payment required: ${data?.message || 'insufficient credits'}`,
        {
          status: 402,
          detail: data,
          actionable:
            `The dVeracity account is out of API credits (balance: ${data?.balance ?? 'unknown'}, ` +
            `needed: ${data?.needed ?? 'unknown'}). Ask your human operator to purchase credits ` +
            `(POST ${data?.purchaseUrl || '/api/v1/vaas/credits/purchase'}) or upgrade the ` +
            'subscription at https://dveracity.com/pricing, then retry.',
        }
      );
    }
    if (res.status === 401) {
      if (/keri session/i.test(data?.message || '')) {
        // Distinct from key failures so request() can transparently re-auth.
        throw new SemanticApiError(data.message, { status: 401, detail: data });
      }
      throw new SemanticApiError('Authentication failed: invalid or expired API key', {
        status: 401,
        detail: data,
        actionable:
          'The DVERACITY_API_KEY is invalid, revoked, or expired. Ask your human operator for a ' +
          'valid dvrc_ key (created at POST /api/v1/api-keys with an api-tier subscription).',
      });
    }
    if (res.status === 403 && data?.error === 'insufficient_scope') {
      throw new SemanticApiError(`Credential scope denied: ${data.message}`, {
        status: 403,
        detail: data,
        actionable:
          `The agent's Authorization credential carries scopes [${(data.carried || []).join(', ')}] ` +
          `but this call requires '${data.required}'. Ask the human operator to have the Legal ` +
          'Entity issue a credential carrying the needed scope.',
      });
    }
    throw new SemanticApiError(
      `dVeracity API error ${res.status}: ${data?.message || 'request failed'}`,
      { status: res.status, detail: data }
    );
  }

  /** Natural-language question over the verified-emissions knowledge graph. */
  query(query, sessionId) {
    return this.request('POST', '/api/v1/semantic/query', {
      query,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  /** Catalog of supported query templates (free). */
  templates() {
    return this.request('GET', '/api/v1/semantic/templates');
  }

  /** Current credit balance for the authenticated account. */
  credits() {
    return this.request('GET', '/api/v1/vaas/credits');
  }

  /** Validate a data payload against a supported standard (VaaS). */
  validate(payload) {
    return this.request('POST', '/api/v1/vaas/validate', payload);
  }

  /** List standards VaaS can validate against (free, public). */
  standards() {
    return this.request('GET', '/api/v1/vaas/standards');
  }

  // ── Open Footprint canonical model (design time, all free) ──────────────

  /** The eight model domains and which DDL dialects carry published output. */
  ofpModels() {
    return this.request('GET', '/api/v1/ofp/models');
  }

  /** Search or list canonical entities. */
  ofpEntities({ q, domain, limit } = {}) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (domain) params.set('domain', domain);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return this.request('GET', `/api/v1/ofp/entities${qs ? `?${qs}` : ''}`);
  }

  /**
   * One entity. Pass `domain` whenever it is known: 48 entity names are
   * defined in more than one domain, and the bare form deliberately fails
   * with 409 rather than picking one.
   */
  ofpEntity(name, domain) {
    const path = domain
      ? `/api/v1/ofp/entities/${encodeURIComponent(domain)}/${encodeURIComponent(name)}`
      : `/api/v1/ofp/entities/${encodeURIComponent(name)}`;
    return this.request('GET', path);
  }

  /** Industry sectors across both classification axes, each with a status. */
  ofpSectors(axis) {
    return this.request('GET', `/api/v1/ofp/sectors${axis ? `?axis=${encodeURIComponent(axis)}` : ''}`);
  }

  /** One sector, with its reference artifacts. */
  ofpSector(id) {
    return this.request('GET', `/api/v1/ofp/sectors/${encodeURIComponent(id)}`);
  }

  /** A sector's Rego guardrails, or an explicit statement that none are published. */
  ofpPolicies(id) {
    return this.request('GET', `/api/v1/ofp/sectors/${encodeURIComponent(id)}/policies`);
  }

  /** O-DEF semantic codes: list, optionally only those specific enough to align on. */
  ofpSemantics(maxFieldCount) {
    const qs = maxFieldCount ? `?maxFieldCount=${encodeURIComponent(maxFieldCount)}` : '';
    return this.request('GET', `/api/v1/ofp/semantics${qs}`);
  }

  /** The canonical fields carrying one O-DEF code. */
  ofpSemanticCode(code) {
    return this.request('GET', `/api/v1/ofp/semantics/${encodeURIComponent(code)}`);
  }

  /** Which snapshot of the standard this deployment is serving. */
  ofpMeta() {
    return this.request('GET', '/api/v1/ofp/meta');
  }

  /** Metered: check a payload against the model and, optionally, sector guardrails. */
  ofpValidate({ entity, domain, payload, sector, entityType }) {
    return this.request('POST', '/api/v1/ofp/validate', {
      entity,
      ...(domain ? { domain } : {}),
      payload,
      ...(sector ? { sector } : {}),
      ...(entityType ? { entityType } : {}),
    });
  }
}
