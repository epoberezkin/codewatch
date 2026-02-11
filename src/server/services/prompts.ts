// Spec: spec/services/prompts.md
import * as fs from 'fs';
import * as path from 'path';

// Spec: spec/services/prompts.md#loadPrompt
export function loadPrompt(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid prompt name: ${name}`);
  }
  const promptsDir = path.join(__dirname, '..', '..', '..', 'prompts');
  let filePath = path.join(promptsDir, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    const altDir = path.join(__dirname, '..', '..', 'prompts');
    filePath = path.join(altDir, `${name}.md`);
  }
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Prompt template not found: ${name}`);
  }
}

// Spec: spec/services/prompts.md#renderPrompt
export function renderPrompt(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}
