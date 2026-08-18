#!/bin/sh
# Refuses a command that needs `node_modules` in a checkout that has never installed, and
# says what to run instead of naming a binary. One argument: the devbox script about to run,
# which is what the message names. See AGENTS.md § Development and #133.
#
# A checked-in file rather than a shell function in `devbox.json`'s `init_hook`, and that is
# the whole reason this exists as a file at all. devbox generates one script per key and has
# it source the hook **only when a devbox shell is not already active** — the generated
# script guards `. .hooks.sh` on `__DEVBOX_SKIP_INIT_HOOK_<hash>`. Exported *variables*
# survive into that child shell, which is why the port derivation in the hook beside it never
# noticed; a shell *function* does not. So a guard defined in the hook was missing exactly
# when `devbox run …` is used the second way AGENTS.md documents — from inside
# `devbox shell` — and every script failed at 127 with `kobai_require_install: command not
# found`, which is a worse version of the failure this exists to remove.
#
# It answers "nothing has installed here", never "what is installed is current": a stale
# `node_modules` is what the gate's own `--frozen-lockfile` is for.

root=${DEVBOX_PROJECT_ROOT:-.}

if [ -d "$root/node_modules" ]; then
  exit 0
fi

printf '\n  Nothing has installed in this checkout, so `devbox run %s` has no binaries to run.\n  Run `devbox run install` first, or `devbox run ci`, which installs before everything else.\n  See AGENTS.md § Development.\n\n' "$1" >&2
exit 1
