# Contributor guidance

## Privacy and test fixtures

- Never commit real telephone numbers, personal contact details, live call IDs, webhook payloads, API credentials, or other operational data from conversations or logs to this public repository.
- Use only clearly fictional telephone numbers in source, tests, examples, commit messages, and pull requests. For E.164-style examples, prefer the reserved North American fictional range `12025550100` through `12025550199`.
- When reproducing issues from real traffic, anonymize all identifiers and review diffs for personal data before pushing.
- Keep deployment secrets outside this repository.
