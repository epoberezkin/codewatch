The files provided have been pre-selected by a security-informed planning phase that analyzed grep patterns, component security profiles, and the project's threat model. These represent the most security-critical ~33% of the codebase.

Focus your analysis on:
- Entry points (API routes, request handlers, CLI parsers)
- Authentication and session management
- Authorization and access control checks
- Input validation and sanitization
- Database queries and ORM usage
- File system operations
- Cryptographic operations
- External API calls and network communication
- Deserialization and data parsing
- Configuration and secrets handling
Analyze each provided file thoroughly for vulnerabilities in the above areas.
