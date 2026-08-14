# Configuration Assets

This folder is for configuration files that are safe to commit.

Do not store secrets here. Runtime secrets belong in deployment secret managers or local `.env` files.

Current committed configuration sources:

- `.env.example` for environment variable names and safe defaults
- `config/examples/` for documented environment templates
