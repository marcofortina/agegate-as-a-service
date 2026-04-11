# Incident Response and Breach Notification

This document outlines the procedures to follow in the event of a security incident or personal data breach involving the Age Gate as a Service platform. These procedures are designed to comply with the GDPR (General Data Protection Regulation) and other applicable regulations.

## Definitions

- **Personal data breach**: A breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data transmitted, stored or otherwise processed.
- **Incident**: Any event that compromises the confidentiality, integrity, or availability of the service or its data.
- **Controller**: The customer using Age Gate as a Service (the website or service that integrates the age verification).
- **Processor**: Age Gate as a Service (the service itself).

## Roles and Responsibilities

- **Security Officer**: Person responsible for coordinating incident response (typically the system administrator or DevOps lead).
- **Privacy Contact**: Person responsible for communicating with data controllers and supervisory authorities.
- **Technical Team**: Developers and operators who investigate and remediate the incident.

## Incident Response Phases

### 1. Detection and Identification

Any team member who suspects a security incident must immediately report it to the Security Officer. Incidents can be detected via:
- Automated alerts from Prometheus (e.g., high error rate, unexpected traffic patterns).
- Log analysis (Pino logs, Kubernetes audit logs).
- User reports (e.g., clients reporting unusual verification results).
- Routine security scans or penetration tests.

### 2. Containment and Eradication

Upon confirmation of an incident, the Technical Team shall:
- Isolate affected components (e.g., block IP ranges, rotate secrets, take pods offline).
- Preserve forensic data (logs, database snapshots) for later analysis.
- Apply temporary fixes (e.g., rate limiting, firewall rules) to stop ongoing damage.
- Revoke potentially compromised API keys and rotate database passwords.

### 3. Investigation and Analysis

The Technical Team will:
- Determine the root cause and scope of the breach.
- Identify which data may have been accessed or exposed.
- Assess whether personal data (including anonymised IP hashes) was involved.
- Document all findings in a confidential incident report.

### 4. Notification (Breach Communication)

If the incident involves a personal data breach, the following notification obligations apply under GDPR (Article 33 and 34):

#### Notification to the Supervisory Authority (e.g., Garante Privacy)
- **Timeline**: Within 72 hours from becoming aware of the breach.
- **Content**: Description of the breach, categories and approximate number of data subjects concerned, likely consequences, and measures taken.
- **Method**: Via the authority’s online portal or designated contact.

#### Communication to Data Controllers (Customers)
- The Processor (Age Gate) shall notify each affected Controller without undue delay.
- The notification shall describe the nature of the breach, the data involved, and recommended actions for the Controller.
- Controllers are then responsible for notifying their end users if required.

#### When notification is not required
- If the breach is unlikely to result in a risk to the rights and freedoms of natural persons.
- If appropriate technical and organisational protections (e.g., encryption, anonymisation) have been applied.

### 5. Recovery and Remediation

After containment, the Technical Team will:
- Restore affected systems from verified backups.
- Apply permanent fixes (e.g., patch vulnerabilities, update configurations).
- Test the fix to ensure no recurrence.

### 6. Post‑Incident Review

Within 30 days of resolving the incident, the Security Officer will:
- Prepare a final incident report.
- Identify lessons learned and update security policies or technical controls.
- Share relevant findings with the team and, if required, with affected controllers.

## Documentation and Log Retention

- All incident‑related logs and reports shall be retained for at least one year.
- The `admin_audit_log` table in the database captures administrative actions; this should be reviewed for suspicious activity.

## Training and Testing

- Incident response procedures shall be reviewed and tested at least once per year (e.g., tabletop exercises).
- All team members shall receive basic security awareness training.

## Contact Points

For reporting incidents, contact the Security Officer at `security@agegate.example.com` (replace with actual email). For privacy matters, contact the Data Protection Officer (if appointed) or the Privacy Contact.

## Related Documents

- [Backup and Restore](./backup-restore.md)
- [Security Measures](./security.md)
- [Privacy & Double Anonymity](./privacy.md)
