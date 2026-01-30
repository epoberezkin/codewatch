Focus your analysis on security-critical code paths, analyzing approximately one-third of the codebase. Prioritize:
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
Skim remaining code for obvious red flags but focus depth on the above areas.
