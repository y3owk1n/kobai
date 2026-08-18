#!/bin/sh
# Refuses a command that needs `node_modules` in a Project that has never installed, and says
# what to run instead of naming a binary. One argument: the devbox script about to run, which
# is what the message names.
#
# **A Project is in that state the day it is generated** — it is the only state it has ever
# been in — and the first command run in one is `devbox run dev` or `devbox run build`.
# Without this they failed with `Command "vite" not found`: a message naming a binary nobody
# scaffolding a Project has heard of, leaving the reader to work out that a package manager
# never ran.
#
# The `node_modules` it looks for is the Project root's, which is where one `pnpm install`
# puts both this Project's dependencies and its Admin's — the Admin is a workspace package of
# this Project and has a second `node_modules` beside it, written by the same install.
#
# It is a file rather than a shell function in `devbox.json`'s `init_hook`, and that part is
# not a preference: devbox generates one script per key and has it source the hook **only
# when a devbox shell is not already active**, so a function defined there is missing from
# every script run from inside `devbox shell` — each one dying at exit 127 naming the function
# rather than saying anything a reader could act on.
#
# It answers "nothing has installed here", never "what is installed is current".
#
# This is kobai's own `scripts/require-install.sh`, shipped into the Project because a Project
# owns its files outright and reaches into no repository that generated it. Every line of code
# below is identical in the two, and kobai's own test suite fails naming the line if that stops
# being true; what may differ is `fix` and `note`, and this comment, which no test compares.
# See https://github.com/y3owk1n/kobai/blob/main/AGENTS.md#development

# What to run instead, and the other way out. This is a Project rather than kobai's own
# checkout, so there is no gate to reach for — and `devbox run up` installs nothing here at
# all, because it builds and runs this Project inside the image.
fix='Run `devbox run install` first.'
note='Or `devbox run up`, which builds and runs this Project in Docker and installs nothing here.'

root=${DEVBOX_PROJECT_ROOT:-.}

if [ -d "$root/node_modules" ]; then
  exit 0
fi

printf '\n  Nothing has installed in this checkout, so `devbox run %s` has no binaries to run.\n  %s\n  %s\n\n' "$1" "$fix" "$note" >&2
exit 1
