# Security policy

## Supported version

Security fixes are made on the current `main` branch and released in the next maintained package version.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability. Use GitHub's private security advisory flow for this repository, including a minimal reproduction, affected version/commit, impact, and suggested mitigation if available. If private advisories are unavailable, contact the repository maintainer through the email shown on the GitHub profile and avoid sharing secrets or exploit details publicly.

We will acknowledge a good-faith report, investigate it, and coordinate disclosure and a fix where practical. Do not test against systems you do not own or have permission to assess.

## Scope notes

VLD's local Runtime, Studio, agent adapters, catalog/store inputs, generated packets, and CLI input validation are in scope. Never include operator tokens, credentials, or private customer data in a report.
