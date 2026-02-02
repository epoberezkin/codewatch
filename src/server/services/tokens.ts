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
const SECURITY_CRITICAL_PATTERNS = [
  /\bauth\b/i, /\bcrypto\b/i, /\bapi\b/i, /\broute/i, /\bmiddleware\b/i,
  /\bhandler/i, /\bcontroller/i, /\bmodel/i, /\bdb\b/i, /\bdatabase\b/i,
  /\bconfig\b/i, /\bsecur/i, /\bsession\b/i, /\btoken\b/i, /\bpassword\b/i,
  /\bpermission\b/i, /\baccess\b/i, /\bvalidat/i, /\bsaniti/i,
];

// ---------- Rough Token Count ----------

export function roughTokenCount(files: ScannedFile[]): number {
  return files.reduce((sum, f) => sum + f.roughTokens, 0);
}

// ---------- Cost Estimation ----------

export async function estimateCosts(
  pool: Pool,
  files: ScannedFile[],
  modelId: string = 'claude-opus-4-5-20251101',
): Promise<CostEstimate> {
  const pricing = await getModelPricing(pool, modelId);
  const totalFiles = files.length;
  const totalTokens = roughTokenCount(files);

  // Sort files by security criticality for thorough mode
  const scoredFiles = files.map(f => ({
    ...f,
    securityScore: SECURITY_CRITICAL_PATTERNS.reduce(
      (score, pattern) => score + (pattern.test(f.relativePath) ? 1 : 0),
      0
    ),
  }));
  scoredFiles.sort((a, b) => b.securityScore - a.securityScore);

  // Full: all files
  const fullTokens = totalTokens;

  // Thorough: ~33% prioritizing security-critical paths
  const thoroughFileCount = Math.ceil(totalFiles * 0.33);
  const thoroughFiles = scoredFiles.slice(0, thoroughFileCount);
  const thoroughTokens = roughTokenCount(thoroughFiles);

  // Opportunistic: ~10%
  const opportunisticFileCount = Math.ceil(totalFiles * 0.10);
  const opportunisticFiles = scoredFiles.slice(0, opportunisticFileCount);
  const opportunisticTokens = roughTokenCount(opportunisticFiles);

  return {
    totalFiles,
    totalTokens,
    estimates: {
      full: {
        files: totalFiles,
        tokens: fullTokens,
        costUsd: calculateLevelCost(totalTokens, 'full', pricing),
      },
      thorough: {
        files: thoroughFileCount,
        tokens: thoroughTokens,
        costUsd: calculateLevelCost(totalTokens, 'thorough', pricing),
      },
      opportunistic: {
        files: opportunisticFileCount,
        tokens: opportunisticTokens,
        costUsd: calculateLevelCost(totalTokens, 'opportunistic', pricing),
      },
    },
    isPrecise: false,
  };
}

/**
 * Compute cost estimates from a known precise total token count.
 */
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
        costUsd: calculateLevelCost(totalTokens, 'full', pricing),
      },
      thorough: {
        files: Math.ceil(totalFiles * 0.33),
        tokens: thoroughTokens,
        costUsd: calculateLevelCost(totalTokens, 'thorough', pricing),
      },
      opportunistic: {
        files: Math.ceil(totalFiles * 0.10),
        tokens: opportunisticTokens,
        costUsd: calculateLevelCost(totalTokens, 'opportunistic', pricing),
      },
    },
    isPrecise: true,
  };
}

// Level multipliers represent analysis proportion + planning overhead:
// Full: 100% of code + 5% planning = 1.05x
// Thorough: 33% of code + 5% planning = 0.38x
// Opportunistic: 10% of code + 5% planning = 0.15x
const LEVEL_MULTIPLIERS: Record<string, number> = {
  full: 1.05,
  thorough: 0.38,
  opportunistic: 0.15,
};

// Estimated ratio of output tokens to input tokens per analysis batch.
// Security audits produce structured JSON findings (~15% of input size).
const ESTIMATED_OUTPUT_RATIO = 0.15;

function calculateLevelCost(
  totalTokens: number,
  level: string,
  pricing: ModelPricing,
): number {
  const multiplier = LEVEL_MULTIPLIERS[level] ?? 1.05;
  const inputTokens = totalTokens * multiplier;
  const outputTokens = inputTokens * ESTIMATED_OUTPUT_RATIO;
  const cost = (inputTokens / 1_000_000) * pricing.inputCostPerMtok
             + (outputTokens / 1_000_000) * pricing.outputCostPerMtok;
  return Math.round(cost * 10000) / 10000;
}

/**
 * Compute cost estimates scoped to selected components.
 * Uses pre-computed estimated_tokens from the components table.
 */
export async function estimateCostsForComponents(
  pool: Pool,
  componentIds: string[],
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

  const totalFiles = parseInt(rows[0].total_files);
  const totalTokens = parseInt(rows[0].total_tokens);

  const thoroughTokens = Math.round(totalTokens * 0.33);
  const opportunisticTokens = Math.round(totalTokens * 0.10);

  return {
    totalFiles,
    totalTokens,
    estimates: {
      full: {
        files: totalFiles,
        tokens: totalTokens,
        costUsd: calculateLevelCost(totalTokens, 'full', pricing),
      },
      thorough: {
        files: Math.ceil(totalFiles * 0.33),
        tokens: thoroughTokens,
        costUsd: calculateLevelCost(totalTokens, 'thorough', pricing),
      },
      opportunistic: {
        files: Math.ceil(totalFiles * 0.10),
        tokens: opportunisticTokens,
        costUsd: calculateLevelCost(totalTokens, 'opportunistic', pricing),
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
