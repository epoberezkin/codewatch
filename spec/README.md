# CodeWatch Specification

> Engineering specification reverse-engineered from source code. All claims verified against commit `51a1dc8`.

## Purpose

This directory contains a complete technical specification of the CodeWatch system. Every document was produced by reading the source code directly; no claims are assumed. Where gaps or inconsistencies exist, they are marked with `[GAP]`. Improvement recommendations are marked with `[REC]`.

## How to Use

1. **Start with [architecture.md](architecture.md)** for the system overview, dependency graph, and key design decisions.
2. **Use [api.md](api.md)** for the full HTTP endpoint reference.
3. **Use [services/*.md](services/)** for implementation details of each server-side module.
4. **Use [database.md](database.md)** for schema, migrations, and constraints.
5. **Use [diagrams/*.md](diagrams/)** for visual understanding (Mermaid diagrams).
6. **Use [client/*.md](client/)** for client-side module documentation.

## Document Index

| Document | Covers | Source Files |
|----------|--------|--------------|
| [architecture.md](architecture.md) | System architecture, design decisions, dependency graph | `app.ts`, `index.ts` |
| [database.md](database.md) | Schema, migrations, constraints | `sql/*.sql`, `db.ts` |
| [api.md](api.md) | All API endpoints | `routes/api.ts` |
| [auth.md](auth.md) | Authentication, authorization, gate middleware | `routes/auth.ts`, `middleware/gate.ts` |
| [config.md](config.md) | Configuration, environment variables | `config.ts` |
| [prompts.md](prompts.md) | Prompt templates | `prompts/*.md` |
| [testing.md](testing.md) | Test infrastructure | `test/` |
| [impact.md](impact.md) | Change impact graph — source file → product behavior mapping | all `src/` |
| [services/audit.md](services/audit.md) | Audit orchestration | `services/audit.ts` |
| [services/componentAnalysis.md](services/componentAnalysis.md) | Component analysis | `services/componentAnalysis.ts` |
| [services/github.md](services/github.md) | GitHub API integration | `services/github.ts` |
| [services/planning.md](services/planning.md) | Audit planning phase | `services/planning.ts` |
| [services/tokens.md](services/tokens.md) | Token counting, cost estimation | `services/tokens.ts` |
| [services/claude.md](services/claude.md) | Claude API wrapper | `services/claude.ts` |
| [services/ownership.md](services/ownership.md) | Ownership resolution | `services/ownership.ts` |
| [services/git.md](services/git.md) | Git operations | `services/git.ts` |
| [services/prompts.md](services/prompts.md) | Prompt loading and rendering | `services/prompts.ts` |
| [client/README.md](client/README.md) | Client architecture overview | `src/client/` |
| [client/common.md](client/common.md) | Shared utilities | `client/common.ts` |
| [client/home.md](client/home.md) | Home page | `client/home.ts` |
| [client/estimate.md](client/estimate.md) | Estimate page | `client/estimate.ts` |
| [client/audit.md](client/audit.md) | Audit page | `client/audit.ts` |
| [client/report.md](client/report.md) | Report page | `client/report.ts` |
| [client/project.md](client/project.md) | Project page | `client/project.ts` |
| [client/projects.md](client/projects.md) | Projects browser | `client/projects.ts` |
| [diagrams/system-context.md](diagrams/system-context.md) | System context diagram | -- |
| [diagrams/er-diagram.md](diagrams/er-diagram.md) | Entity-relationship diagram | -- |
| [diagrams/data-flow.md](diagrams/data-flow.md) | Data flow diagram | -- |
| [diagrams/state-machines.md](diagrams/state-machines.md) | State machine diagrams | -- |

## Reverse Index

Source file to spec document mapping. Every `src/` file is listed with the spec document(s) that cover it.

### Server

| Source File | Spec Documents |
|-------------|---------------|
| `src/server/index.ts` | [architecture.md](architecture.md) |
| `src/server/app.ts` | [architecture.md](architecture.md), [auth.md](auth.md), [api.md](api.md), [config.md](config.md) |
| `src/server/config.ts` | [config.md](config.md) |
| `src/server/db.ts` | [database.md](database.md) |
| `src/server/migrate.ts` | [database.md](database.md) |
| `src/server/middleware/gate.ts` | [auth.md](auth.md) |
| `src/server/routes/api.ts` | [api.md](api.md) |
| `src/server/routes/auth.ts` | [auth.md](auth.md) |
| `src/server/services/audit.ts` | [services/audit.md](services/audit.md) |
| `src/server/services/componentAnalysis.ts` | [services/componentAnalysis.md](services/componentAnalysis.md) |
| `src/server/services/github.ts` | [services/github.md](services/github.md) |
| `src/server/services/planning.ts` | [services/planning.md](services/planning.md) |
| `src/server/services/tokens.ts` | [services/tokens.md](services/tokens.md) |
| `src/server/services/claude.ts` | [services/claude.md](services/claude.md) |
| `src/server/services/ownership.ts` | [services/ownership.md](services/ownership.md) |
| `src/server/services/git.ts` | [services/git.md](services/git.md) |
| `src/server/services/prompts.ts` | [services/prompts.md](services/prompts.md) |

### Client

| Source File | Spec Documents |
|-------------|---------------|
| `src/client/common.ts` | [client/common.md](client/common.md) |
| `src/client/home.ts` | [client/home.md](client/home.md) |
| `src/client/estimate.ts` | [client/estimate.md](client/estimate.md) |
| `src/client/audit.ts` | [client/audit.md](client/audit.md) |
| `src/client/report.ts` | [client/report.md](client/report.md) |
| `src/client/project.ts` | [client/project.md](client/project.md) |
| `src/client/projects.ts` | [client/projects.md](client/projects.md) |

### Other

| Source / Config File | Spec Documents |
|---------------------|---------------|
| `sql/*.sql` | [database.md](database.md), [diagrams/er-diagram.md](diagrams/er-diagram.md) |
| `prompts/*.md` | [prompts.md](prompts.md) |
| `Dockerfile` | [architecture.md](architecture.md) |
| `docker-compose.yml` | [architecture.md](architecture.md), [config.md](config.md) |
| `package.json` | [architecture.md](architecture.md), [testing.md](testing.md) |
| `test/` | [testing.md](testing.md) |

## Conventions

All spec documents follow these conventions:

- **Source links** use the format: [`functionName()`](../src/server/file.ts#L45-L89)
- **`[GAP]`** marks missing functionality, undocumented behavior, or inconsistencies found in source
- **`[REC]`** marks improvement recommendations
- **Line numbers** were verified at time of writing against commit `51a1dc8`
- **Mermaid diagrams** are used for all visual representations (dependency graphs, state machines, ER diagrams, flow charts)
