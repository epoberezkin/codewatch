// Spec: spec/services/tokens.md
import { Pool } from 'pg';
import { ScannedFile } from './git';

// ---------- Types ----------

export interface LevelEstimate {
  files: number;
  tokens: number;
  costUsd: number;
}

export interface CostEstimate {
  totalFiles: number;
  totalTokens: number;
  estimates: {
    full: LevelEstimate;
    thorough: LevelEstimate;
    opportunistic: LevelEstimate;
  };
  isPrecise: boolean;
}

interface ModelPricing {
  modelId: string;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  contextWindow: number;
  maxOutput: number;
}

// Security-critical path patterns for thorough mode prioritization
export const SECURITY_CRITICAL_PATTERNS = [
  /\bauth\b/i, /\bcrypto\b/i, /\bapi\b/i, /\broute/i, /\bmiddleware\b/i,
  /\bhandler/i, /\bcontroller/i, /\bmodel/i, /\bdb\b/i, /\bdatabase\b/i,
  /\bconfig\b/i, /\bsecur/i, /\bsession\b/i, /\btoken\b/i, /\bpassword\b/i,
  /\bpermission\b/i, /\baccess\b/i, /\bvalidat/i, /\bsaniti/i,
];

// Budget percentages by audit level (analysis portion only)
export const BUDGET_PERCENTAGES: Record<string, number> = {
  full: 1.0,
  thorough: 0.33,
  opportunistic: 0.10,
};

// ---------- Rough Token Count ----------

// Spec: spec/services/tokens.md#roughTokenCount
export function roughTokenCount(files: ScannedFile[]): number {
  return files.reduce((sum, f) => sum + f.roughTokens, 0);
}

// ---------- Cost Estimation ----------

// Spec: spec/services/tokens.md#estimateCosts
export async function estimateCosts(
  pool: Pool,
  files: ScannedFile[],
  modelId: string = 'claude-opus-4-5-20251101',
): Promise<CostEstimate> {
  const pricing = await getModelPricing(pool, modelId);
  const totalFiles = files.length;
  const totalTokens = roughTokenCount(files);

  const thoroughTokens = Math.round(totalTokens * 0.33);
  const opportunisticTokens = Math.round(totalTokens * 0.10);

  return {
    totalFiles,
    totalTokens,
    estimates: {
      full: {
        files: totalFiles,
        tokens: totalTokens,
        costUsd: calculateLevelCost(totalTokens, totalTokens, pricing),
      },
      thorough: {
        files: Math.ceil(totalFiles * 0.33),
        tokens: thoroughTokens,
        costUsd: calculateLevelCost(thoroughTokens, totalTokens, pricing),
      },
      opportunistic: {
        files: Math.ceil(totalFiles * 0.10),
        tokens: opportunisticTokens,
        costUsd: calculateLevelCost(opportunisticTokens, totalTokens, pricing),
      },
    },
    isPrecise: false,
  };
}

/**
 * Compute cost estimates from a known precise total token count.
 */
// Spec: spec/services/tokens.md#estimateCostsFromTokenCount
export async function estimateCostsFromTokenCount(
  pool: Pool,
  totalFiles: number,
  totalTokens: number,
  modelId: string = 'claude-opus-4-5-20251101',
): Promise<CostEstimate> {
  const pricing = await getModelPricing(pool, modelId);

  const thoroughTokens = Math.round(totalTokens * 0.33);
  const opportunisticTokens = Math.round(totalTokens * 0.10);

  return {
    totalFiles,
    totalTokens,
    estimates: {
      full: {
        files: totalFiles,
        tokens: totalTokens,
        costUsd: calculateLevelCost(totalTokens, totalTokens, pricing),
      },
      thorough: {
        files: Math.ceil(totalFiles * 0.33),
        tokens: thoroughTokens,
        costUsd: calculateLevelCost(thoroughTokens, totalTokens, pricing),
      },
      opportunistic: {
        files: Math.ceil(totalFiles * 0.10),
        tokens: opportunisticTokens,
        costUsd: calculateLevelCost(opportunisticTokens, totalTokens, pricing),
      },
    },
    isPrecise: true,
  };
}

// Component analysis overhead: 5% of total project tokens (fixed cost, independent of audit level).
const ANALYSIS_OVERHEAD = 0.05;

// Estimated ratio of output tokens to input tokens per analysis batch.
// Security audits produce structured JSON findings (~15% of input size).
const ESTIMATED_OUTPUT_RATIO = 0.15;

function calculateLevelCost(
  levelTokens: number,
  totalTokens: number,
  pricing: ModelPricing,
): number {
  const inputTokens = levelTokens + totalTokens * ANALYSIS_OVERHEAD;
  const outputTokens = inputTokens * ESTIMATED_OUTPUT_RATIO;
  const cost = (inputTokens / 1_000_000) * pricing.inputCostPerMtok
             + (outputTokens / 1_000_000) * pricing.outputCostPerMtok;
  return Math.round(cost * 10000) / 10000;
}

/**
 * Compute cost estimates scoped to selected components.
 * Uses pre-computed estimated_tokens from the components table.
 */
// Spec: spec/services/tokens.md#estimateCostsForComponents
export async function estimateCostsForComponents(
  pool: Pool,
  componentIds: string[],
  projectTotalTokens: number,
  modelId: string = 'claude-opus-4-5-20251101',
): Promise<CostEstimate> {
  if (componentIds.length === 0) {
    return {
      totalFiles: 0,
      totalTokens: 0,
      estimates: {
        full: { files: 0, tokens: 0, costUsd: 0 },
        thorough: { files: 0, tokens: 0, costUsd: 0 },
        opportunistic: { files: 0, tokens: 0, costUsd: 0 },
      },
      isPrecise: false,
    };
  }

  const pricing = await getModelPricing(pool, modelId);

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(estimated_files), 0) as total_files,
            COALESCE(SUM(estimated_tokens), 0) as total_tokens
     FROM components WHERE id = ANY($1)`,
    [componentIds]
  );

  const totalFiles = parseInt(rows[0].total_files) || 0;
  const totalTokens = parseInt(rows[0].total_tokens) || 0;

  const thoroughTokens = Math.round(totalTokens * 0.33);
  const opportunisticTokens = Math.round(totalTokens * 0.10);

  return {
    totalFiles,
    totalTokens,
    estimates: {
      full: {
        files: totalFiles,
        tokens: totalTokens,
        costUsd: calculateLevelCost(totalTokens, projectTotalTokens, pricing),
      },
      thorough: {
        files: Math.ceil(totalFiles * 0.33),
        tokens: thoroughTokens,
        costUsd: calculateLevelCost(thoroughTokens, projectTotalTokens, pricing),
      },
      opportunistic: {
        files: Math.ceil(totalFiles * 0.10),
        tokens: opportunisticTokens,
        costUsd: calculateLevelCost(opportunisticTokens, projectTotalTokens, pricing),
      },
    },
    isPrecise: false,
  };
}

async function getModelPricing(pool: Pool, modelId: string): Promise<ModelPricing> {
  const { rows } = await pool.query(
    'SELECT model_id, input_cost_per_mtok, output_cost_per_mtok, context_window, max_output FROM model_pricing WHERE model_id = $1',
    [modelId]
  );

  if (rows.length === 0) {
    // Fallback to Opus 4.5 pricing
    return {
      modelId: 'claude-opus-4-5-20251101',
      inputCostPerMtok: 5.0,
      outputCostPerMtok: 25.0,
      contextWindow: 200000,
      maxOutput: 64000,
    };
  }

  return {
    modelId: rows[0].model_id,
    inputCostPerMtok: parseFloat(rows[0].input_cost_per_mtok),
    outputCostPerMtok: parseFloat(rows[0].output_cost_per_mtok),
    contextWindow: rows[0].context_window,
    maxOutput: rows[0].max_output,
  };
}
