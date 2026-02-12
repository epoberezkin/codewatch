# CodeWatch Glossary

Domain terms used throughout the CodeWatch codebase, alphabetically sorted.

---

### Access Tier
One of three permission levels -- **Owner**, **Requester**, or **Public** -- resolved at report-view time to control finding visibility and actions. *See: [responsible-disclosure.md](flows/responsible-disclosure.md)*

### Agentic Loop
The iterative Claude tool-use cycle in component analysis where the model calls `list_directory`, `read_file`, and `search_files` across up to 40 turns until it produces a final JSON result. *See: [component-analysis.md](flows/component-analysis.md)*

### Audit Level (Full / Thorough / Opportunistic)
The depth of a security audit, expressed as a percentage of total project tokens analyzed: **Full** (100%), **Thorough** (~33%), **Opportunistic** (~10%). *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Audit Plan
The ranked list of files selected by Claude during the planning phase, with priority scores (1--10) and reasons, stored in `audits.audit_plan`. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Base Audit
A previously completed audit selected as the reference point for an incremental audit; its commit SHAs and findings are used to compute diffs and inherit results. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Batch (Analysis Batch)
A group of files totaling up to 150,000 tokens, sent together in a single Claude API call during the analysis phase; files are sorted by directory path to keep related code together. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### BYOK (Bring Your Own Key)
The model where users supply their own Anthropic API key (`sk-ant-...`) to pay for Claude usage, rather than CodeWatch bearing the cost. *See: [README.md](README.md)*

### Classification
The first-audit-only step where Claude categorizes the project (e.g., `library`, `cli_tool`, `client_server`) and generates a description, involved parties, and threat model. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Component
An architectural unit of a project identified by component analysis, defined by a name, description, role, repository, file glob patterns, languages, and an optional security profile. *See: [component-analysis.md](flows/component-analysis.md)*

### Component Analysis
An optional agentic AI step that explores repository structure to identify components, their security profiles, and project dependencies, enabling scoped auditing. *See: [component-analysis.md](flows/component-analysis.md)*

### Component Attribution
The post-analysis step that matches each finding's `file_path` against component `file_patterns` using glob matching and assigns the first matching component. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### CWE (Common Weakness Enumeration)
A standardized identifier for software weakness types (e.g., CWE-79 for XSS), attached to each finding by Claude during batch analysis. *See: [responsible-disclosure.md](flows/responsible-disclosure.md)*

### CVSS (Common Vulnerability Scoring System)
A numeric score (0.0--10.0) indicating vulnerability severity, assigned to each finding alongside the CWE identifier. *See: [responsible-disclosure.md](flows/responsible-disclosure.md)*

### Dependency
A third-party package detected during component analysis, recorded with name, version, ecosystem (e.g., `npm`, `pip`, `cargo`), and optional source repository URL. *See: [component-analysis.md](flows/component-analysis.md)*

### Disclosure Period
The time window between owner notification and automatic report publication -- 6 months for critical findings, 3 months for high/medium, immediate for low/informational/none (no findings). *See: [responsible-disclosure.md](flows/responsible-disclosure.md)*

### Entity (GitHub)
A GitHub user or organization that owns one or more repositories; the `github_org` field on a project identifies the entity whose repos are being audited. *See: [authentication.md](flows/authentication.md)*

### Finding
A single security issue discovered by Claude during batch analysis, with severity, CWE, CVSS, file location, code snippet, description, exploitation scenario, and recommendation. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Fingerprint (Finding Dedup)
A SHA-256 hash of `file_path : line_range : title : first_100_chars_of_code_snippet`, truncated to 16 hex characters, used to deduplicate findings across incremental audits. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Gate (Pre-Launch)
A password-protected landing page (`/gate.html`) that restricts site access during pre-launch via a signed cookie. *See: [README.md](README.md)*

### Incremental Audit
An audit that uses `git diff` against a base audit's commits to analyze only added, modified, and renamed files, inheriting open findings from the base. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Involved Parties
A structured record of stakeholders identified during classification -- each party has a name and lists of capabilities (`can`) and restrictions (`cannot`). *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Max Severity
The highest severity level among all findings in an audit, computed during synthesis and stored on the audit record; drives disclosure period length. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Model Pricing
Per-model cost rates stored in the `model_pricing` database table (input/output cost per million tokens, context window, max output); defaults to Opus 4.5 at $5/$25 per Mtok. *See: [tokens.md](../spec/services/tokens.md)*

### Org Scope (`read:org`)
The GitHub OAuth scope requested during authentication to enable organization membership verification; stored as `has_org_scope` on the session. *See: [authentication.md](flows/authentication.md)*

### Ownership
The verified relationship between a GitHub user and the audited entity, determined via personal account match, org admin membership, or repo admin permissions fallback. *See: [authentication.md](flows/authentication.md)*

### Ownership Cache
A database table (`ownership_cache`) that stores resolved ownership results with a 15-minute TTL to avoid repeated GitHub API calls; invalidated on re-authentication. *See: [authentication.md](flows/authentication.md)*

### Publishable After
A timestamp set on the audit record when the owner is notified, indicating when the report will be auto-published; computed from `max_severity` and the disclosure delay table. *See: [responsible-disclosure.md](flows/responsible-disclosure.md)*

### Redaction
The removal of sensitive finding fields (title, description, exploitation, recommendation, code snippet, file path) for medium/high/critical findings when viewed by a non-owner requester. *See: [responsible-disclosure.md](flows/responsible-disclosure.md)*

### Repo Local Path
The filesystem path where a cloned repository is stored, computed by `repoLocalPath()` as `config.reposDir / hostname / org / repo`. *See: [git.md](../spec/services/git.md)*

### Rough Token Count
A character-based heuristic estimate of token count, computed as `Math.ceil(fileSize / 3.3)` per file, used for cost estimation before precise counting is available. *See: [tokens.md](../spec/services/tokens.md)*

### Scoped Estimate
A cost estimate recalculated when the user selects specific components, summing only the selected components' `estimated_files` and `estimated_tokens` while scaling overhead to the full project. *See: [component-analysis.md](flows/component-analysis.md)*

### Security Grep
Local regex-based scanning of all files for security-sensitive patterns (injection, SQL, auth, crypto, network, file I/O) run before the Claude planning call to inform file prioritization. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Security Profile
A per-component structure containing a summary, list of sensitive areas (path + reason), and threat surface entries, produced during component analysis. *See: [component-analysis.md](flows/component-analysis.md)*

### Session
A server-side authentication record stored in the `sessions` table, linked to a user and GitHub token, with a 14-day expiry checked on every authenticated request. *See: [authentication.md](flows/authentication.md)*

### Shallow Clone
A git clone optimization using `--depth 1` (fresh clones) or `--shallow-since` (incremental audits, based on base commit date minus 1 day) to reduce clone size and time. *See: [git.md](../spec/services/git.md)*

### Synthesis
The final audit phase where all findings are sent to Claude to produce an executive summary, security posture assessment, and `max_severity` computation. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Threat Model
A structured security model for the project, either extracted from the repository or generated by Claude during classification, describing parties and their capabilities. *See: [audit-lifecycle.md](flows/audit-lifecycle.md)*

### Threat Surface
A list of attack vectors or exposed interfaces identified per component during component analysis (e.g., "HTTP endpoints", "file system access"). *See: [component-analysis.md](flows/component-analysis.md)*

### Token Budget
The maximum number of input tokens allocated for file analysis at a given audit level, calculated as the audit level percentage of total project tokens. *See: [tokens.md](../spec/services/tokens.md)*

### Watch (Project Watch)
A user subscription to a project stored in the `project_watches` table, enabling notifications or "My Projects" filtering on the projects browser. *See: [README.md](README.md)*
