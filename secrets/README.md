# secrets/

Docker Compose secret files (`*.txt`, one value per file) are generated here by
`scripts/generate-secrets.mjs` and passed to services via compose `secrets:`; services read
them through `*_FILE` environment variables.

Everything in this directory except this README and `.gitkeep` is gitignored. Never commit,
copy, print or log these files. Claude Code agents are denied read access via
`.claude/settings.json`.
