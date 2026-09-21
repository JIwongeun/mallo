# Security policy

Mallo reads local Codex transcripts, so privacy and path-containment bugs are security-sensitive.

## Supported versions

Mallo is alpha software. This repository tracks the current development version and has no long-term support branches.

## Report a vulnerability

If GitHub private vulnerability reporting is available for this repository, use the [private advisory form](https://github.com/JIwongeun/mallo/security/advisories/new).

If that form is unavailable, open a minimal issue asking for a private contact path. Do not include exploit details or sensitive evidence in the public issue.

Include, through the private channel:

- affected version or commit;
- operating system and Codex surface;
- impact and reproduction steps;
- the smallest sanitized evidence needed to confirm the issue.

Never submit raw transcripts, prompts, command arguments, tool results, credentials, API keys, tokens, private reasoning, or personal filesystem paths.

## Scope

Relevant reports include unauthorized transcript access, path-containment bypasses, sensitive-data exposure, unsafe hook behavior, and dependency or installation issues that affect Mallo. General Codex platform vulnerabilities should be reported to the platform owner.
