# Security review — TAEL Books 1.0

Reviewed controls and where they live in the code.

| Control | Implementation |
|---|---|
| Authentication | bcrypt (cost 12) password hashes; dummy-hash compare for unknown emails (timing); lockout after N failed sign-ins (Admin Center → Security); sign-in rate limit 20 / 15 min / IP — `server/src/routes/auth.js` |
| Sessions | Random 256-bit token in an HTTP-only, SameSite=Lax, Secure (prod) cookie; only its SHA-256 is stored; sliding expiry; password change and resets revoke other sessions |
| CSRF | Per-session token required in `X-CSRF-Token` for every state-changing request — `middleware/auth.js` |
| Authorization | 50 granular permissions checked server-side on every route (`need(...)`) and again inside services for financial actions; role transaction limits; segregation of duties for approvals; users cannot grant permissions they do not hold; multi-company isolation by `company_id` on every query |
| Accounting integrity | DB constraint triggers: posted entries must balance, posted lines immutable, no posting into locked/closed periods, lines must belong to the entry's company; all postings inside one transaction |
| Audit trail | Append-only `audit_logs` (UPDATE/DELETE blocked by trigger), SHA-256 hash chain verifiable in Admin Center → Audit logs; sensitive fields redacted |
| Input validation | zod schemas on all write endpoints; parameterised SQL everywhere; numeric/date filters validated; friendly mapped DB errors; no stack traces returned |
| Uploads | Size limit; file type determined from magic bytes, not the browser; SVGs with scripts/external refs rejected; stored outside the web root under random names; served with `nosniff` and a restrictive CSP |
| Secrets | AI keys and SMTP passwords encrypted with AES-256-GCM (`APP_ENCRYPTION_KEY`); never returned to the browser; API keys stored as SHA-256 hashes and limited to non-admin permissions |
| HTTP hardening | Helmet CSP, HSTS (prod), frame-ancestors self, `x-powered-by` off, JSON body limit, general API rate limit, AI rate limit |
| AI safety | AI can only call read tools and a draft-creating tool; tools enforce the user's permissions; drafts require approval; every AI query/draft/approval audited; answers carry sources |
| Backups | Database backup/restore Super Admin only, checksum verified, typed confirmation, automatic safety backup before restore |
| Dependencies | `npm audit` clean (server and client) at release |

## Production checklist

1. Serve only over HTTPS (Caddy config in `deploy/`), `COOKIE_SECURE=true`, `TRUST_PROXY=1`.
2. Generate a long random `APP_ENCRYPTION_KEY` and store it in your secrets manager.
3. Use a strong, unique database password; restrict database network access to the app.
4. Remove `SUPER_ADMIN_PASSWORD` from the environment after first start; change it in the app.
5. Enable automatic daily backups at your database provider and test a restore.
6. Keep one instance with `JOBS_ENABLED=true`.
7. Review users, roles and the audit log regularly; lock periods after month-end.
