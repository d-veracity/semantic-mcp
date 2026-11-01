/**
 * Tool pricing for the published server, mirroring the backend's
 * config/toolPricing.js.
 *
 * `_meta.pricing` lets an agent see what a call costs before it makes one.
 * The hosted endpoint overrides this value at registration time from the
 * backend's copy (which reads the deployment's billing environment); the
 * stdio package uses these defaults, overridable by the same environment
 * variables the backend uses, so a self-hosted operator can keep the two in
 * step without editing code.
 */

const intEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const usdEnv = () => {
  const parsed = Number.parseFloat(process.env.CREDIT_USD_VALUE || '0.01');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.01;
};

export const TOOL_CREDIT_COSTS = Object.freeze({
  semantic_query: intEnv('SEMANTIC_QUERY_CREDIT_COST', 1),
  validate_data: intEnv('VAAS_VALIDATION_CREDIT_COST', 1),
  ofp_validate: intEnv('OFP_VALIDATE_CREDIT_COST', 1),
  compliance_evaluate: 0,
});

// Minimum subscription tier, mirroring the backend's requireTier gates.
// compliance_evaluate costs 0 credits but is not free: reading `amount` alone
// would make a plan refusal look like a price bug.
export const TOOL_PLAN_REQUIREMENTS = Object.freeze({
  compliance_policies: 'vaas',
  compliance_policy: 'vaas',
  compliance_policy_register: 'vaas',
  compliance_evaluation: 'vaas',
  compliance_evaluate: 'vaas',
});

export function creditCost(toolName) {
  return Object.prototype.hasOwnProperty.call(TOOL_CREDIT_COSTS, toolName)
    ? TOOL_CREDIT_COSTS[toolName]
    : 0;
}

export function planRequiredForTool(toolName) {
  return TOOL_PLAN_REQUIREMENTS[toolName] || null;
}

export function pricingForTool(toolName) {
  const amount = creditCost(toolName);
  const planRequired = planRequiredForTool(toolName);
  return {
    unit: 'credit',
    amount,
    usd: Number((amount * usdEnv()).toFixed(2)),
    ...(planRequired ? { plan_required: planRequired } : {}),
  };
}
