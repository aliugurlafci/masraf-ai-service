# projects/

Registered project repositories live here (one directory per project). The directory is
bind-mounted **read-only** into the worker container at runtime; the worker never writes to
these repositories. Each task runs in an isolated Git worktree created under `workspaces/`.

Contents of this directory are gitignored (only this README and `.gitkeep` are tracked).
