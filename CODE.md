# Coding and building

This file provides guidance on coding style and approaches and on building the code.

## Code Security

When designing code and planning implementations:
- Apply adversarial thinking, and consider what may happen if one of the communicating parties is malicious.
- Formulate an explicit threat model for each change - who can do which undesirable things and under which circumstances.

## Code Style, Formatting and Approaches

**Follow existing code patterns:**
- Match the style of surrounding code
- Use record syntax for types with multiple fields
- Prefer explicit pattern matching over partial functions

**Comments policy:**
- Avoid redundant comments that restate what the code already says
- Only comment on non-obvious design decisions or tricky implementation details
- Function names and type signatures should be self-documenting
- Do not add comments like "wire format encoding" (Encoding class is always wire format) or "check if X" when the function name already says that
- Assume a competent Haskell reader

**Diff and refactoring:**
- Avoid unnecessary changes and code movements
- Never do refactoring unless it substantially reduces cost of solving the current problem, including the cost of refactoring
- Aim to minimize the code changes - do what is minimally required to solve users' problems

**Document and code structure:**
- **Never move existing code or sections around** - add new content at appropriate locations without reorganizing existing structure.
- When adding new sections to documents, continue the existing numbering scheme.
- Minimize diff size - prefer small, targeted changes over reorganization.

**Code analysis and review:**
- Trace data flows end-to-end: from origin, through storage/parameters, to consumption. Flag values that are discarded and reconstructed from partial data (e.g. extracted from a URI missing original fields) — this is usually a bug.
- Read implementations of called functions, not just signatures — if duplication involves a called function, check whether decomposing it resolves the duplication.
- Do not save time on analysis. Read every function in the data flow even when the interface seems clear — wrong assumptions about internals are the main source of missed bugs.

---

## Documentation Maintenance

### Purpose
The `product/` and `spec/` folders contain the authoritative product requirements and engineering specification for CodeWatch, reverse-engineered from code. These documents MUST stay synchronized with the codebase as it evolves — because stale documentation is worse than no documentation, creating false confidence in incorrect information.

### Requirements

1. **Update spec/ when changing code.** When modifying any source file in `src/`, update the corresponding spec document to reflect the change. Why: spec documents map 1:1 to source files, and divergence between spec and code defeats the purpose of having specifications.

2. **Update product/ when changing user-visible behavior.** When a change affects what users see or how they interact with the system, update the relevant view document in `product/views/` and any affected flow documents in `product/flows/`. Why: product documents describe the contract with users, and silent changes to that contract create confusion.

3. **Update line number references.** When editing source files, verify and update the line number references in the corresponding spec document (format: `(L45-L89)`). Why: stale line numbers make spec documents misleading and reduce their navigational value.

4. **Maintain cross-references.** When adding new source files, add corresponding spec documents and update `spec/README.md` document index and reverse index. When adding new pages, add corresponding `product/views/` and `spec/client/` documents. Why: completeness of the documentation system depends on every source file being covered.

5. **Add [GAP] annotations for discovered issues.** When encountering missing error handling, dead code, inconsistencies, or incomplete features during code review, add a `[GAP]` annotation in the relevant spec or product document and add a summary to `product/gaps.md`. Why: this builds institutional knowledge about technical debt.

6. **Add [REC] annotations for improvement ideas.** When identifying potential improvements during code changes, add a `[REC]` annotation in the relevant document. Why: capturing improvement ideas at discovery time preserves context that is lost later.

7. **Run adversarial self-review.** After completing code changes and documentation updates, verify consistency between the changed source files, their spec documents, and any affected product documents. Check that: all new functions appear in spec, all changed behavior appears in product, all line numbers are current, all cross-references resolve. Why: the value of documentation degrades exponentially with inaccuracy — one wrong reference undermines trust in all references.

8. **Preserve document structure.** Follow the existing format conventions in each document type: spec documents use function-anchored links with line numbers, product documents use screenshot references and interaction descriptions, flow documents use Mermaid diagrams. Why: consistent structure makes documents predictable and faster to navigate.

### Document Map

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
| src/server/migrate.ts | spec/database.md | - |
| src/server/config.ts | spec/config.md | - |
| src/server/db.ts | spec/database.md | - |
| src/client/*.ts | spec/client/*.md | product/views/*.md |
| sql/*.sql | spec/database.md | - |
| prompts/*.md | spec/prompts.md | - |
