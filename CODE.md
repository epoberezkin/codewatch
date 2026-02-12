# Coding and building

You are an expert developer for CodeWatch, an AI-powered security audit platform. You MUST navigate and develop this codebase using the three-layer documentation architecture described below. You MUST NOT write code without first loading the relevant product and spec context.

## Three-Layer Documentation Architecture

### Why this structure exists

LLMs start each session with no persistent understanding of the codebase. Navigating thousands of lines of flat source code to reconstruct behavior, constraints, and intent wastes context window and produces unreliable results.

The `product/`, `spec/`, and `src/` layers form a persistent, structured representation of the system that survives across sessions. Each layer is connected to the next by bidirectional cross-references. This structure enables you to load only the context relevant to a specific change, understand all affected concepts, and maintain coherence as the system evolves.

### The layers

| Layer | Contains | Question it answers |
|-------|----------|-------------------|
| `product/` | Capabilities, user flows, views, business rules, glossary | **What** does the system do and why? |
| `spec/` | Technical design, API contracts, database schema, service internals | **How** is it organized technically? |
| `src/` | Executable TypeScript code | What does it **execute**? |

Each layer links to the next:
- `product/concepts.md` links every concept to its spec docs, source files, and tests in a single table — this is the primary navigation entry point
- `product/views/*.md` and `product/flows/*.md` each have a **Related spec:** line linking to their most relevant spec documents
- `product/glossary.md` uses *See: [spec/...]* references and `product/rules.md` uses **Spec:** [spec/...] references to link individual terms and rules down to spec
- `spec/` documents contain **Source:** headers and inline function links pointing down to source. Line references MUST be clickable by embedding the `#Lxx-Lyy` fragment in the link URL: [`functionName()`](../../src/server/file.ts#Lxx-Lyy). You MUST NOT duplicate line numbers in the display text — the URL fragment is sufficient. Why: redundant line numbers in display text create maintenance burden on every line shift.
- Reverse direction: the Document Map (end of this file) maps source → spec → product

### Navigation workflow

When the user requests any change, you MUST follow these steps before writing any code:

1. **Identify scope.** You MUST read `product/concepts.md` and find which product concepts are affected by the requested change. Each row links to the relevant product docs, spec docs, source files, and tests. Why: concepts.md is the fastest path to identify all affected documents — skipping it risks missing impacted areas.

2. **Load product context.** You MUST read the relevant `product/views/*.md` or `product/flows/*.md` to understand current user-facing behavior. For business constraints, you MUST read `product/rules.md`. Why: product documents define the intended behavior — changing code without understanding current behavior risks breaking the user contract.

3. **Load spec context.** You MUST follow the product → spec links to read the relevant `spec/*.md` or `spec/services/*.md`. You MUST understand the technical design, function signatures, and data flows. Why: spec documents reveal technical constraints and invariants that product docs omit — ignoring them leads to implementations that violate existing guarantees.

4. **Load source context.** You MUST follow the spec → src links (with line numbers) to read the relevant source files. Why: source code is the ground truth — product and spec may lag behind actual behavior.

5. **Identify full impact.** You MUST read `spec/impact.md` to find all product concepts affected by the source files you plan to change. This determines which documents you MUST update after the code change. Why: without impact analysis, documentation updates will be incomplete, and future sessions will navigate using stale information.

For internal-only changes that do not map to a product concept (infrastructure, refactoring, non-user-facing fixes), you MUST start at step 3 using the Document Map to find the relevant spec document, then proceed to steps 4–6.

6. **Implement.** Make the code change in `src/`, then you MUST update all affected documentation as described in the Change Protocol below.

### Key navigation documents

| Document | Purpose | When to read |
|----------|---------|-------------|
| `product/concepts.md` | Concept → doc → code → test cross-reference | Starting point for every change |
| `product/rules.md` | Business invariants with enforcement locations and tests | Before modifying any behavior |
| `product/glossary.md` | Domain term definitions | When encountering unfamiliar terms |
| `product/gaps.md` | Known issues and recommendations | Before designing a fix or feature |
| `spec/impact.md` | Source file → affected product concepts | After identifying which files to change |
| Document Map (below) | Source ↔ spec ↔ product mapping | When updating documentation |

---

## Code Security

When designing code and planning implementations, you MUST:
- Apply adversarial thinking, and consider what may happen if one of the communicating parties is malicious. Why: security vulnerabilities arise from untested assumptions about trust boundaries.
- Formulate an explicit threat model for each change — who can do which undesirable things and under which circumstances. Why: explicit threat models catch attack vectors that implicit reasoning misses.

---

## Code Style

**Follow existing code patterns — you MUST:**
- Match the style of surrounding code. Why: consistent style reduces cognitive load and prevents unnecessary diff noise.
- Use TypeScript interfaces for record types and union types for variants. Why: interfaces and unions leverage the type system for compile-time correctness.
- Prefer exhaustive type narrowing over type assertions. Why: type assertions bypass compiler checks and hide bugs.

**Comments policy — you MUST:**
- Only comment on non-obvious design decisions or tricky implementation details. Why: redundant comments create maintenance burden and drift from code.
- Keep function names and type signatures self-documenting. Why: good names eliminate the need for most comments.
- Assume a competent TypeScript reader. Why: over-explaining trivial TypeScript adds noise without value.

**Diff and refactoring — you MUST:**
- Avoid unnecessary changes and code movements. Why: unnecessary changes increase review burden and hide the meaningful diff.
- Never do refactoring unless it substantially reduces cost of solving the current problem, including the cost of refactoring itself. Why: speculative refactoring has guaranteed present cost with uncertain future benefit.
- Minimize the code changes — do what is minimally required to solve users' problems. Why: smaller diffs are easier to review, less likely to introduce bugs, and faster to revert.

**Document and code structure — you MUST:**
- **Never move existing code or sections around** — add new content at appropriate locations without reorganizing existing structure. Why: moving code creates large diffs that obscure the actual change and break git blame.
- When adding new sections to documents, continue the existing numbering scheme. Why: consistent numbering preserves document navigability.
- Minimize diff size — prefer small, targeted changes over reorganization. Why: large diffs compound review errors and make rollback difficult.

**Code analysis and review — you MUST:**
- Trace data flows end-to-end: from origin, through storage/parameters, to consumption. Flag values that are discarded and reconstructed from partial data (e.g. extracted from a URI missing original fields) — this is usually a bug. Why: broken data flows are the most common source of security and correctness bugs.
- Read implementations of called functions, not just signatures — if duplication involves a called function, check whether decomposing it resolves the duplication. Why: function signatures can be misleading about actual behavior.
- Read every function in the data flow even when the interface seems clear. Why: wrong assumptions about internals are the main source of missed bugs.

---

## Plans

When developing via plans (non-trivial features, multi-step changes, architectural decisions), you MUST store the plan in the `plans/` folder before implementing. Why: plans are the persistent record of design decisions and rationale — without them, future sessions cannot understand why the system was built the way it was.

### Plan requirements

1. **File naming.** You MUST use the format `YYYYMMDD_NN.md` (e.g., `20260211_01.md`). Why: chronological ordering makes it easy to trace the evolution of design decisions.

2. **Plan structure.** Every plan MUST include: (1) Problem statement, (2) Solution summary, (3) Detailed technical design, (4) Detailed implementation steps. Why: incomplete plans lead to ad-hoc implementation that drifts from intent.

3. **Consistency with product/ and spec/.** The plan MUST be consistent with the current state of `product/` and `spec/`. If the plan introduces new behavior, it MUST describe which product and spec documents will be affected. Why: plans that contradict existing documentation create conflicting sources of truth.

4. **Adversarial self-review.** After writing the plan, you MUST run the same adversarial self-review as for code changes: verify the plan is internally consistent, consistent with product/ and spec/, and does not introduce contradictions. You MUST repeat until two consecutive passes find zero issues. Why: an incoherent plan produces incoherent implementation.

---

## Change Protocol

### The rule

Every code change MUST include corresponding updates to `spec/` and `product/`. A task is NOT complete until all three layers are coherent with each other. Why: these layers are the persistent memory that enables coherent development across sessions — stale documentation creates false confidence and compounds errors in every future change.

### What to update

1. **spec/ — on every code change.** You MUST update the corresponding spec document to reflect the change. You MUST add new functions, update changed signatures, and remove deleted ones. Why: spec documents map 1:1 to source files — divergence defeats specification.

2. **product/ — when user-visible behavior changes.** You MUST update the relevant `product/views/*.md` and any affected `product/flows/*.md`. You MUST update `product/rules.md` when business invariants change. Why: product documents are the contract with users — silent changes create confusion.

3. **Line number references — on every code change.** You MUST verify and update all `#Lxx-Lyy` references in affected spec documents. Why: stale line numbers make spec documents misleading and destroy navigational value.

4. **Cross-references — when adding or removing files.** You MUST add corresponding spec documents and update `spec/README.md` document index and reverse index. When adding pages, you MUST add `product/views/` and `spec/client/` documents. You MUST update the Document Map at the end of this file. Why: every source file must be covered for the navigation system to work.

5. **Impact graph — when adding files or changing what a file affects.** You MUST update `spec/impact.md` to reflect the source file → product concept mapping. Why: the impact graph drives documentation updates for all future changes — an incomplete graph causes future changes to miss required updates.

6. **Concept index — when adding or changing product concepts.** You MUST add or update the relevant row in `product/concepts.md` with links to product docs, spec docs, source files, and tests. Why: the concept index is the entry point for all future navigation — a missing row means future changes to that concept will miss context.

7. **[GAP] annotations — when discovering issues.** When encountering missing error handling, dead code, inconsistencies, or incomplete features, you MUST add a `[GAP]` annotation in the relevant spec or product document and add a summary to `product/gaps.md`. Why: this builds institutional knowledge about technical debt.

8. **[REC] annotations — when identifying improvements.** You MUST add a `[REC]` annotation in the relevant document. Why: capturing improvement ideas at discovery time preserves context that is lost later.

9. **Preserve document structure.** You MUST follow existing format conventions: spec documents use function-anchored links with line numbers, product documents use interaction descriptions, flow documents use Mermaid diagrams. Why: consistent structure makes documents predictable and navigable.

### Adversarial self-review

After completing all changes (code + documentation), you MUST run an adversarial self-review. You MUST check coherence both within each layer and across layers.

**Within-layer coherence — you MUST verify:**
- spec/ is internally consistent — no contradictory descriptions, state machines have no unreachable states, data model is referentially intact
- product/ is internally consistent — flows match views, rules match behavior descriptions

**Across-layer coherence — you MUST verify:**
- Every new or changed function in src/ appears in the corresponding spec/ document
- Every user-visible behavior change in src/ appears in the relevant product/ document
- All `#Lxx-Lyy` line references in affected spec documents point to the correct lines
- All cross-references resolve — product → spec links, spec → src links
- `spec/impact.md` covers all affected product concepts for the changed source files
- `product/concepts.md` rows are current for any affected concepts

**Convergence:** You MUST repeat the review-and-fix cycle until two consecutive passes find zero issues. You MUST fix all issues discovered between passes. Why: LLM non-determinism means a single review pass may miss violations — two consecutive clean passes provide confidence that the layers are coherent.

---

## Document Map

| Source Location | Spec Document | Product Document |
|----------------|---------------|-----------------|
| src/server/routes/api.ts | spec/api.md | product/views/*.md (all views) |
| src/server/routes/auth.ts | spec/auth.md | product/flows/authentication.md |
| src/server/middleware/gate.ts | spec/auth.md | product/views/gate.md |
| src/server/services/audit.ts | spec/services/audit.md | product/flows/audit-lifecycle.md |
| src/server/services/componentAnalysis.ts | spec/services/componentAnalysis.md | product/flows/component-analysis.md |
| src/server/services/github.ts | spec/services/github.md | product/flows/authentication.md |
| src/server/services/planning.ts | spec/services/planning.md | product/flows/audit-lifecycle.md |
| src/server/services/tokens.ts | spec/services/tokens.md | product/views/estimate.md |
| src/server/services/claude.ts | spec/services/claude.md | - |
| src/server/services/ownership.ts | spec/services/ownership.md | product/flows/authentication.md |
| src/server/services/git.ts | spec/services/git.md | - |
| src/server/services/prompts.ts | spec/services/prompts.md | - |
| src/server/index.ts | spec/architecture.md | - |
| src/server/app.ts | spec/architecture.md | - |
| src/server/migrate.ts | spec/database.md | - |
| src/server/config.ts | spec/config.md | - |
| src/server/db.ts | spec/database.md | - |
| src/client/*.ts | spec/client/*.md | product/views/*.md |
| sql/*.sql | spec/database.md | - |
| prompts/*.md | spec/prompts.md | - |
