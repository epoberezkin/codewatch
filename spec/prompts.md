# Prompt Template System

## Overview

Prompt templates are Markdown files in `/prompts/` loaded at runtime by `src/server/services/prompts.ts`. The module exposes two functions:

- **`loadPrompt(name: string): string`** -- Reads `prompts/{name}.md` from disk. Validates the name against `/^[a-zA-Z0-9_-]+$/` to prevent path traversal. Tries `__dirname/../../../prompts/` first, then `__dirname/../../prompts/` as fallback.
- **`renderPrompt(template: string, vars: Record<string, string>): string`** -- Replaces all `{{key}}` placeholders with the corresponding value via global regex substitution.

All variable values are passed as plain strings; callers are responsible for serializing objects (e.g., `JSON.stringify`).

---

## Templates

### 1. classify.md

- **File:** [`classify.md`](../prompts/classify.md)
- **Purpose:** Classify a software project by category, identify involved parties, detect or generate a threat model.
- **Template variables:**
  - `{{repo_list}}` -- Rendered repository listing with directory trees and README excerpts.
- **Expected output format:** JSON object:
  ```
  {
    "category": "library" | "cli_tool" | "build_dependency" | "gui_client" | "client_server" | "decentralized_serverless" | "decentralized_client_server",
    "description": string,
    "involved_parties": { "vendor": string, "operators": string[], "end_users": string[], "networks": string[] },
    "components": [{ "repo": string, "role": string, "languages": string[] }],
    "threat_model_found": boolean,
    "threat_model_files": string[],
    "threat_model": { "evaluation": string, "generated": string, "parties": [{ "name": string, "can": string[], "cannot": string[] }] }
  }
  ```
- **Used by:** `audit.ts` > `classifyProject()`. Called with system prompt `"You are a software classification expert. Analyze projects and respond with valid JSON only."`.
- **Key instructions:** Respond with valid JSON. Categorize the project, identify parties (vendor, operators, end users, networks), evaluate an existing threat model or generate one in party->can/cannot format.

---

### 2. component_analysis.md

- **File:** [`component_analysis.md`](../prompts/component_analysis.md)
- **Purpose:** Agentic analysis of repository structure to identify components, security profiles, and dependencies. The model is given tools (`list_directory`, `read_file`, `search_files`) to explore the codebase.
- **Template variables:**
  - `{{repo_list}}` -- Rendered list of repositories with top-level directory listings.
- **Expected output format:** JSON object:
  ```
  {
    "components": [{
      "name": string,
      "description": string,
      "role": "server" | "client" | "library" | "cli" | "worker" | "shared" | "config" | "test",
      "repo": string,
      "file_patterns": string[],
      "languages": string[],
      "security_profile": {
        "summary": string,
        "sensitive_areas": [{ "path": string, "reason": string }],
        "threat_surface": string[]
      }
    }],
    "dependencies": [{
      "name": string,
      "version": string,
      "ecosystem": string,
      "repo": string,
      "source_repo_url": string
    }]
  }
  ```
- **Used by:** `componentAnalysis.ts` > `runComponentAnalysis()`. Used as the system prompt in a multi-turn agentic loop (up to 40 turns) with tool use.
- **Key instructions:** Explore repos using tools, identify components with glob file patterns, profile security-sensitive areas per component, detect dependencies from manifest files, use standard threat surface categories (`authentication`, `authorization`, `cryptography`, `sql_injection`, `command_injection`, `xss`, `file_access`, `network`, `secrets`, `deserialization`, `input_validation`).

---

### 3. planning.md

- **File:** [`planning.md`](../prompts/planning.md)
- **Purpose:** Rank all source code files by security audit priority using project context, grep results, and component profiles.
- **Template variables:**
  - `{{category}}` -- Project category (e.g., `client_server`).
  - `{{description}}` -- Project description.
  - `{{threat_model}}` -- Threat model text (party->can/cannot format).
  - `{{component_profiles}}` -- Rendered component security profiles.
  - `{{grep_results}}` -- Security grep hits with sample matches, plus full file list.
  - `{{audit_level}}` -- Audit level string (`full`, `thorough`, or `opportunistic`).
- **Expected output format:** JSON array:
  ```
  [{ "file": string, "priority": 1-10, "reason": string }]
  ```
- **Used by:** `planning.ts` > `runPlanningCall()`. Called with system prompt `"You are a security audit planner. Return valid JSON only."` using the planning model (Claude Opus 4.5).
- **Key instructions:** Rank every file by security audit priority considering: threat surface alignment, grep signal strength, component sensitivity, attack surface exposure, data flow criticality. Priority scale: 9-10 critical security code, 7-8 high importance, 5-6 moderate, 3-4 low, 1-2 minimal.

---

### 4. system.md

- **File:** [`system.md`](../prompts/system.md)
- **Purpose:** System prompt for the main security audit analysis. Sets the auditor persona and defines the expected finding format.
- **Template variables:**
  - `{{category}}` -- Project category.
  - `{{description}}` -- Project description.
  - `{{components}}` -- JSON-serialized component list.
  - `{{involved_parties}}` -- JSON-serialized involved parties map.
  - `{{threat_model}}` -- Threat model text or JSON parties array.
- **Expected output format:** JSON object:
  ```
  {
    "findings": [{
      "severity": "critical" | "high" | "medium" | "low" | "informational",
      "cwe_id": string,
      "cvss_score": number,
      "file": string,
      "line_start": number,
      "line_end": number,
      "title": string,
      "description": string,
      "exploitation": string,
      "recommendation": string,
      "code_snippet": string
    }],
    "responsible_disclosure": object,
    "dependencies": [{ "name": string, "concern": string }],
    "security_posture": string
  }
  ```
- **Used by:** `audit.ts` > `buildSystemPrompt()`. Concatenated with a level-specific prompt (see below) to form the full system prompt for analysis batches.
- **Key instructions:** World-class application security auditor persona. Must consider threat model enforcement, cross-component attacks, each party's capabilities. Entire response must be a single valid JSON object with no markdown or surrounding text.

---

### 5. full.md

- **File:** [`full.md`](../prompts/full.md)
- **Purpose:** Level-specific instructions for the **full** audit level (100% of codebase).
- **Template variables:** None.
- **Expected output format:** N/A (appended to system.md; output format defined by system.md).
- **Used by:** `audit.ts` > `buildSystemPrompt()` when `level === 'full'`.
- **Key instructions:** Analyze EVERY line exhaustively. Check all OWASP Top 10 categories, CWE Top 25, memory safety, all injection types, auth/authz flaws, crypto misuse, race conditions, TOCTOU, deserialization, SSRF, path traversal, info disclosure, business logic flaws, supply chain concerns. Do not skip any file or function.

---

### 6. thorough.md

- **File:** [`thorough.md`](../prompts/thorough.md)
- **Purpose:** Level-specific instructions for the **thorough** audit level (~33% of codebase by token budget).
- **Template variables:** None.
- **Expected output format:** N/A (appended to system.md).
- **Used by:** `audit.ts` > `buildSystemPrompt()` when `level === 'thorough'`.
- **Key instructions:** Files pre-selected by security-informed planning phase (grep patterns, component profiles, threat model). Focus on entry points, auth, authz, input validation, DB queries, file I/O, crypto, external APIs, deserialization, config/secrets.

---

### 7. opportunistic.md

- **File:** [`opportunistic.md`](../prompts/opportunistic.md)
- **Purpose:** Level-specific instructions for the **opportunistic** audit level (~10% of codebase by token budget).
- **Template variables:** None.
- **Expected output format:** N/A (appended to system.md).
- **Used by:** `audit.ts` > `buildSystemPrompt()` when `level === 'opportunistic'`.
- **Key instructions:** Highest-priority ~10% of codebase. Focus exclusively on auth/authz entry points, most exposed attack surface, crypto/key management, riskiest code patterns. Every file was selected for a reason -- analyze each carefully.

---

### 8. synthesize.md

- **File:** [`synthesize.md`](../prompts/synthesize.md)
- **Purpose:** Synthesize all audit findings into an executive summary and security posture assessment.
- **Template variables:**
  - `{{description}}` -- Project description.
  - `{{category}}` -- Project category.
  - `{{totalFindings}}` -- Total number of findings (as string).
  - `{{findingsSummary}}` -- Rendered list of findings (severity, title, file, truncated description).
- **Expected output format:** JSON object:
  ```
  { "executive_summary": string, "security_posture": string, "responsible_disclosure": { "contact": string, "policy": string } }
  ```
- **Used by:** `audit.ts` > `runAudit()` (Step 4: Synthesis). Called with system prompt `"You are a security audit report writer. Return valid JSON only."`.
- **Key instructions:** Produce a 2-3 paragraph executive summary and overall security posture assessment paragraph.

---

## Audit Levels and Template Relationships

The audit pipeline has four phases, each using specific templates:

| Phase | Template(s) | Service Function |
|-------|-------------|-----------------|
| 1. Classification | `classify.md` | `audit.ts` > `classifyProject()` |
| 1b. Component Analysis | `component_analysis.md` | `componentAnalysis.ts` > `runComponentAnalysis()` |
| 2. Planning | `planning.md` | `planning.ts` > `runPlanningCall()` |
| 3. Analysis | `system.md` + level prompt | `audit.ts` > `buildSystemPrompt()` |
| 4. Synthesis | `synthesize.md` | `audit.ts` > `runAudit()` |

### Level prompts and budget allocation

| Level | Level Prompt | Token Budget (% of codebase) | File Selection Strategy |
|-------|-------------|------------------------------|------------------------|
| `full` | `full.md` | 100% | All ranked files included |
| `thorough` | `thorough.md` | 33% | Top priority files up to budget |
| `opportunistic` | `opportunistic.md` | 10% | Top priority files up to budget |

Budget percentages are defined in `src/server/services/tokens.ts` as `BUDGET_PERCENTAGES`.

---

## System Prompt Composition

The analysis system prompt (Phase 3) is composed by `buildSystemPrompt()` in `audit.ts`:

```
[system.md rendered with classification variables]
\n\n
[{level}.md -- raw, no variables]
```

Specifically:
1. `loadPrompt('system')` loads system.md.
2. `renderPrompt(systemTemplate, { category, description, components, involved_parties, threat_model })` fills in classification data.
3. `loadPrompt(level)` loads the level-specific prompt (`full.md`, `thorough.md`, or `opportunistic.md`).
4. The two are concatenated with `\n\n`.

The resulting prompt is passed as the `system` parameter to the Anthropic API, while file contents are sent as the `user` message.

---

## Gaps and Recommendations

- [GAP] `system.md` references `{{threat_model}}` but the caller passes either `.threat_model.generated` (a string) or `JSON.stringify(.threat_model.parties)` (a JSON array). The model receives inconsistent formats depending on whether the threat model was generated vs. found in the repo.
  - [REC] Normalize to a consistent rendered text format before injection.

- [GAP] `component_analysis.md` is used as a system prompt in an agentic tool-use loop, but the template itself reads like a user-facing instruction document (includes "## Instructions", "## Output Format"). There is no separate system prompt; the template IS the system prompt.
  - [REC] This works but could be clarified by splitting persona/role framing from task instructions.

- [GAP] The level prompts (`full.md`, `thorough.md`, `opportunistic.md`) contain no template variables and no explicit output format specification. They rely entirely on `system.md` for output format.
  - [REC] This is intentional and correct -- no action needed.

- [GAP] `classify.md` is rendered with `renderPrompt` but is passed as the `user` message (not system prompt). The system prompt is hardcoded as `"You are a software classification expert..."` in `classifyProject()`.
  - [REC] Document this split clearly; consider moving the persona into `classify.md` for consistency with `component_analysis.md`.

- [GAP] `planning.md` is rendered and passed as the `user` message with a separate hardcoded system prompt `"You are a security audit planner. Return valid JSON only."`.
  - [REC] Same as above -- consider unifying persona placement.

- [GAP] `synthesize.md` is rendered and passed as the `user` message with a separate hardcoded system prompt `"You are a security audit report writer. Return valid JSON only."`.
  - [REC] Same as above.

- [GAP] No template versioning or checksumming. If templates are modified on disk between audit runs, results are not reproducible.
  - [REC] Consider storing the rendered prompts (or their hashes) in the audit record for reproducibility.
