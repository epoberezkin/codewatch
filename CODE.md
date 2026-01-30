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
