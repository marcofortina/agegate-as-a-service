# Legal Basis for Processing (GDPR)

This document explains the legal basis for processing personal data in Age Gate as a Service, in compliance with the General Data Protection Regulation (GDPR).

## Controller and Processor Roles

- **Data Controller**: The customer (the website or service using Age Gate) determines the purposes and means of processing end‑user data.
- **Data Processor**: Age Gate as a Service processes data on behalf of the controller, following documented instructions.

## Categories of Personal Data Processed

- **IP addresses** (anonymized via SHA256 + daily rotating salt – not stored in original form)
- **Verification result** (boolean, threshold, timestamp)
- **Client ID** (provided by the customer, e.g., domain name)

## Lawful Basis

The processing is based on **legitimate interest** (Art. 6(1)(f) GDPR). The legitimate interests pursued are:

1. **Preventing underage access** to age‑restricted content, which is a legal obligation for the controller (e.g., AGCOM requirements).
2. **Ensuring service integrity** and preventing abuse (rate limiting, anomaly detection).
3. **Maintaining audit logs** for compliance with regulatory obligations.

## Necessity and Proportionality

The processing is limited to what is strictly necessary:
- No personal identifiers (name, email, ID) are ever collected.
- IP addresses are irreversibly hashed; the original IP is never stored.
- Aggregated data is used for reporting.
- Retention period is set to 30 days (configurable) to balance security and privacy.

## Data Retention

Verification records are automatically deleted after 30 days (see `RETENTION_DAYS` environment variable). This period was chosen because:
- It allows customers to detect patterns of abuse over a reasonable time window.
- It aligns with common industry practices for audit logs.
- It minimizes the risk of long‑term data storage.

The retention policy is enforced by TimescaleDB’s `add_retention_policy`. Customers can adjust the retention period based on their own legal obligations.

## Data Subject Rights

End users have the right to:
- Request information about their data (however, Age Gate does not store identifiable data).
- Request deletion of their data (since no identifiable data is stored, this is automatically satisfied).
- Object to processing (the service cannot function without processing, but the controller may provide alternative means).

## Data Protection Impact Assessment (DPIA)

A DPIA has been conducted (see [Data Protection Impact Assessment](./dpia.md)). The processing does **not** result in high risk to individuals because:
- Data is anonymised (no link to natural persons).
- Retention is limited.
- No profiling or automated decision‑making occurs.

## Contact

For any privacy‑related questions, contact the data controller (the customer using Age Gate). For technical questions about the service, refer to the [project documentation](./).

## Updates

This document may be updated from time to time. Significant changes will be communicated via the release notes.
