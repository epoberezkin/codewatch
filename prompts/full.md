Analyze EVERY line of the provided source code exhaustively. Check for:
- All OWASP Top 10 categories
- CWE Top 25 most dangerous weaknesses
- Memory safety issues (buffer overflows, use-after-free, etc.)
- All injection types (SQL, command, LDAP, XPath, template, etc.)
- Authentication and authorization flaws
- Cryptographic misuse (weak algorithms, improper key management, insufficient entropy)
- Race conditions and TOCTOU
- Deserialization vulnerabilities
- Server-Side Request Forgery (SSRF)
- Path traversal and file inclusion
- Information disclosure and error handling
- Business logic flaws
- Supply chain concerns in dependency usage
Do not skip any file or function. Every code path must be evaluated.
