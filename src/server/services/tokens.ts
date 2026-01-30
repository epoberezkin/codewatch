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
        costUsd: calculateCost(fullTokens, pricing),
      },
      thorough: {
        files: thoroughFileCount,
        tokens: thoroughTokens,
        costUsd: calculateCost(thoroughTokens, pricing),
      },
      opportunistic: {
        files: opportunisticFileCount,
        tokens: opportunisticTokens,
        costUsd: calculateCost(opportunisticTokens, pricing),
      },
    },
    isPrecise: false,
  };
}

function calculateCost(codeTokens: number, pricing: ModelPricing): number {
  const systemPromptTokens = 3000;
  const classifyTokens = 5000;
  const numBatches = Math.max(1, Math.ceil(codeTokens / 150000));
  const inputTokens = systemPromptTokens * numBatches + codeTokens + classifyTokens;
  const outputTokensEstimate = codeTokens * 0.05;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPerMtok;
  const outputCost = (outputTokensEstimate / 1_000_000) * pricing.outputCostPerMtok;

  // Synthesis cost
  const synthesisInput = outputTokensEstimate + 3000;
  const synthesisOutput = 5000; // ~10 pages
  const synthesisCost = (synthesisInput / 1_000_000) * pricing.inputCostPerMtok
    + (synthesisOutput / 1_000_000) * pricing.outputCostPerMtok;

  return Math.round((inputCost + outputCost + synthesisCost) * 10000) / 10000;
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
