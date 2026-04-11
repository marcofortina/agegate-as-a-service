# Data Protection Impact Assessment (DPIA)

This document assesses the risks associated with the processing of personal data by Age Gate as a Service, in compliance with Article 35 of the GDPR. The DPIA is a living document and should be reviewed whenever there are significant changes to the processing or the legal framework.

## 1. Description of the Processing

### 1.1. Purpose

The processing enables website owners (controllers) to verify that a user is above a certain age (e.g., 18) before granting access to age‑restricted content. The purpose is to comply with legal obligations (e.g., AGCOM) and to prevent harm to minors.

### 1.2. Nature and Scope

- **Categories of data subjects**: End users of the controller’s website (natural persons).
- **Categories of personal data**: IP addresses (anonymised immediately), verification result (boolean), threshold (18/21/25), timestamp.
- **Volume**: Variable – depends on the controller’s traffic. The service is designed to handle millions of requests.
- **Data sources**: Directly from the user’s browser via the controller’s frontend integration.
- **Storage**: TimescaleDB (verifications table), Redis (rate limiting counters, session store, IP salt).
- **Retention**: 30 days (configurable). Anonymised IP hashes are never reverted.

### 1.3. Context

The processing is carried out as part of a service offered to controllers (B2B). The controller determines the purposes and means, while Age Gate acts as a processor.

### 1.4. Necessity and Proportionality

The processing is strictly necessary to achieve the age verification goal. No excessive data is collected: no names, emails, or identification documents. The anonymisation of IP addresses reduces the risk to data subjects.

## 2. Consultation with Data Subjects (Optional)

Not required because the processing is low‑risk and not intrusive. However, the controller must provide a transparent privacy policy to end users (see `doc/client-privacy-policy.md`).

## 3. Risk Assessment

| Risk area | Description | Likelihood | Impact | Overall risk |
|-----------|-------------|------------|--------|---------------|
| **Identifiability** | Although IPs are hashed, a motivated attacker with access to the salt could reverse the hash. | Low | High | Medium |
| **Data leakage** | Unauthorised access to the database (verifications table) could expose hashed IPs and verification results. | Low | Medium | Low‑Medium |
| **Unauthorised access to API keys** | Compromised API keys could allow a third party to use the service, potentially causing financial loss or rate limit exhaustion. | Medium | Medium | Medium |
| **Lack of transparency** | End users may not be properly informed about the processing. | Low | Medium | Low |
| **Data retention** | Keeping data longer than necessary could increase privacy risks. | Low | Low | Low (retention policy in place) |
| **Third‑party processor risk** | Age Gate itself relies on cloud infrastructure (K3s, TimescaleDB, Redis). A breach at the infrastructure level could affect the data. | Low | High | Low‑Medium |

## 4. Mitigation Measures

### 4.1. Technical Measures

- **Anonymisation**: IP addresses are hashed using SHA256 with a daily rotating salt. The salt is stored in Redis and rotated every 24 hours. The original IP is never stored.
- **Encryption**: All data in transit is encrypted with TLS (HTTPS). At rest, TimescaleDB volumes are encrypted if the underlying storage supports it (e.g., using KMS).
- **Access control**: Database credentials are stored in Kubernetes secrets. Only the application pods have access. Admin dashboard requires authentication and CSRF protection.
- **Audit logging**: All administrative actions (register, revoke, rotate, set webhook, update limits) are logged in `admin_audit_log`.
- **Rate limiting**: Prevents abuse and DDoS.
- **Regular updates**: The application dependencies are regularly updated to patch vulnerabilities.

### 4.2. Organisational Measures

- **Data protection by default**: The service is configured with the strictest settings (anonymisation, limited retention).
- **Staff training**: The development team receives security awareness training.
- **Incident response**: Documented procedure (`doc/incident-response.md`).
- **Contracts**: Data Processing Agreement (DPA) should be signed with controllers.

### 4.3. Specific Measures for High Risks

| Risk | Mitigation |
|------|-------------|
| Hash reversal | The salt is rotated daily; old salts are discarded after 7 days. Even with a salt, reversing a hash is computationally hard. |
| Database breach | The `verifications` table contains only hashed data. No direct personal data. |
| API key compromise | Keys can be revoked or rotated immediately via admin dashboard or client self‑service. |

## 5. Compliance with GDPR Principles

| Principle | How it is addressed |
|-----------|---------------------|
| Lawfulness, fairness, transparency | Legal basis: legitimate interest (Art. 6(1)(f)). Transparent documentation provided. |
| Purpose limitation | Data used only for age verification and security (rate limiting, audit). |
| Data minimisation | Only IP (hashed), result, threshold, timestamp. No identifiers. |
| Accuracy | Not applicable (no decisions based on inaccurate data). |
| Storage limitation | Retention of 30 days enforced by TimescaleDB policy. |
| Integrity and confidentiality | Encryption, access controls, anonymisation. |
| Accountability | DPIA, documentation, incident response, DPA. |

## 6. Consultation with Supervisory Authority (if required)

The DPIA does not indicate high residual risk that would require prior consultation with the Garante Privacy. However, if the processing volume or scope changes significantly, a consultation may be necessary.

## 7. Review Schedule

This DPIA shall be reviewed annually or upon any significant change to the processing (e.g., new data sources, longer retention, change of legal basis).

## 8. Sign‑off

| Role | Name | Date |
|------|------|------|
| Data Protection Officer (if appointed) | N/A | – |
| Project Owner | Marco Fortina | [date of creation] |
| Security Officer | [name] | [date] |

## 9. Related Documents

- [Legal Basis for Processing](./legal-basis.md)
- [Privacy & Double Anonymity](./privacy.md)
- [Incident Response](./incident-response.md)
- [Backup and Restore](./backup-restore.md)
- [Security Measures](./security.md)
