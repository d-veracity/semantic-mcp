'use strict';

const TOOL_SCOPES = Object.freeze({
  semantic_query: 'semantic:query',
  semantic_templates: 'semantic:templates',
  credits_balance: null,
  list_standards: null,
  keri_identity: null,
  ofp_models: 'ofp:read',
  ofp_model_provenance: 'ofp:read',
  ofp_sectors: 'ofp:read',
  ofp_sector: 'ofp:read',
  ofp_policies: 'ofp:read',
  ofp_search_entities: 'ofp:read',
  ofp_entity: 'ofp:read',
  ofp_semantics: 'ofp:read',
  ofp_semantic_code: 'ofp:read',
  ofp_validate: 'ofp:validate',
  validate_data: 'ofp:validate',
  compliance_policies: 'compliance:read',
  compliance_policy: 'compliance:read',
  compliance_policy_register: 'compliance:read',
  compliance_evaluation: 'compliance:read',
  compliance_evaluate: 'compliance:evaluate',
  // Billing tools: identity is enough; none needs a consent scope of its own.
  billing_plans: null,
  billing_status: null,
  billing_purchase: null,
  billing_subscribe: null,
});

const SCOPES_SUPPORTED = Object.freeze([...new Set(Object.values(TOOL_SCOPES).filter(Boolean))]);

/**
 * Tools callable with no credential at all. billing_plans is the price list an
 * agent reads before it has an account; the hosted route exempts it from the
 * credential gate, so declaring it oauth2 with an empty scope list told clients
 * to start a flow they did not need.
 */
const NOAUTH_TOOLS = Object.freeze(['billing_plans']);

function securitySchemesForTool(name) {
  if (!Object.hasOwn(TOOL_SCOPES, name)) throw new Error(`Missing OAuth scope declaration for ${name}`);
  if (NOAUTH_TOOLS.includes(name)) return [{ type: 'noauth' }];
  const scope = TOOL_SCOPES[name];
  return [{ type: 'oauth2', scopes: scope ? [scope] : [] }];
}

function scopeRefusal(name, authInfo, resourceMetadataUrl) {
  const scope = Object.hasOwn(TOOL_SCOPES, name) && TOOL_SCOPES[name];
  if (!authInfo || !scope || (authInfo.scopes || []).includes(scope)) return null;
  const description = `Re-authorize dVeracity and approve ${scope} to run this tool`;
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl}", error="insufficient_scope", ` +
    `scope="${scope}", error_description="${description}"`;
  return {
    isError: true,
    content: [{ type: 'text', text: `Missing OAuth scope: ${scope}. ${description}` }],
    _meta: { 'mcp/www_authenticate': [challenge] },
  };
}

function enforceToolScopes(transport, authInfo, resourceMetadataUrl) {
  if (!authInfo) return;
  const onmessage = transport.onmessage;
  // Guard before SDK argument validation so malformed calls still trigger step-up.
  transport.onmessage = (message, extra) => {
    if (message.method === 'tools/call' && ['string', 'number'].includes(typeof message.id)) {
      const result = scopeRefusal(message.params?.name, authInfo, resourceMetadataUrl);
      if (result) {
        transport.send({ jsonrpc: '2.0', id: message.id, result })
          .catch((error) => transport.onerror?.(error));
        return;
      }
    }
    onmessage(message, extra);
  };
}

module.exports = {
  TOOL_SCOPES,
  SCOPES_SUPPORTED,
  NOAUTH_TOOLS,
  securitySchemesForTool,
  scopeRefusal,
  enforceToolScopes,
};
