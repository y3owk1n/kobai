# The Postgres credentials come from `.env`, and devbox is where they are encoded

`POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` decide what the `db` service comes up
holding **and** what every address kobai derives signs in with. `devbox.json`'s `init_hook`
reads all three out of `.env` the way it already read `POSTGRES_PORT`, percent-encodes them,
and builds `KOBAI_TEST_DATABASE_URL` and `DATABASE_URL` from the result.

This is [ADR-0031](./0031-the-runtime-shape-devbox-a-pnpm-workspace-hono-and-one-gate.md)'s
one-source rule finishing a job #21 started on the port. The container's address and the
suite's came from one number already; who they let in did not.

## What was wrong

`compose.yaml` has always honoured these three from `.env`. The test harness never did — it
was handed `kobai:kobai` whatever the file said. So a Developer who changed the password got
a container with the new one, a suite dialling the old one, and an authentication failure
that named neither `.env` nor the harness. The container was right and the suite was wrong,
which is the least guessable arrangement of the two.

#21 saw this and deliberately did not half-fix it. Its `.env` reader captured a bare token —
everything up to the first non-alphanumeric — which is all a port needs and is silently wrong
for a password. Wiring that reader to the credentials would have replaced a clear
authentication failure with a mysterious one: the password would have been truncated at its
first punctuation mark, and the URL would have looked entirely reasonable.

So the reader had to grow up first, and it is the same reader. A second parser for the same
file is two answers to "what does `.env` say", and the pair drifts the way the addresses did.

## What the reader does, and why it reads compose's rules

`kobai_dotenv` takes the **last** assignment of a name — with or without a leading `export` —
and hands back the whole value: double-quoted with `\n`, `\r`, `\t`, `\"` and `\\`
interpreted, single-quoted raw, or bare, where leading blanks go and an inline comment must
have whitespace in front of it. That is docker compose's own env-file grammar, and it is
copied rather than chosen: this file *is* compose's `.env`, and a helper that disagreed with
compose about what it said would be the original defect in a subtler form.

**Every clause of that was checked against `docker compose config` reading the same file**,
not against compose's documentation. Two of them were found that way rather than reasoned
out: compose strips a leading `export `, and it expands `\n`/`\r`/`\t` inside double quotes.
A reader that did neither left the container holding one password and the suite dialling
another — this ticket's defect, on lines nobody would have thought to test. Both now have a
case in the suite, and the second is why the encoder walks bytes rather than lines: a value
really can contain a newline, and awk's own record separator had been quietly eating it.

Three limits remain, and `.env.example` states the first two next to the variables:

- **`$` is compose's, not ours.** Compose interpolates variables inside a quoted value in
  `.env` — verified: `POSTGRES_PASSWORD="pa${POSTGRES_USER}word"` reaches the container as
  `pakobaiword` — so a password containing `$` never arrives intact there either. Copying
  that expansion is the one piece of the grammar deliberately left out; keeping `$` out of
  the value is the honest answer, and pretending either way would make the two disagree.
- **A value may not *end* in a newline.** The shell's command substitution strips trailing
  newlines before the encoder ever sees the value, so a password ending in one would reach
  the container and not the suite. Nothing short of a different transport fixes it, and no
  password ends in a newline; it is recorded here rather than left to be discovered.
- **A missing `.env` is not a failure.** devbox sources the hook from a script that opens
  `set -e`, so a reader that reported "no such file" as a non-zero status took down every
  `devbox run …` in the repository — with a bare exit code and no message, because the
  file's stderr was suppressed. Observed while building this. The reader now checks for a
  readable file and returns nothing, and stderr is no longer thrown away, so a real awk
  failure says so instead of hiding behind the same silence.

**There is one reader, and the `DATABASE_URL` line uses it too.** That line does not set the
address from `.env` — `node --env-file` applies the file itself and will not overwrite a
variable already in the environment, so exporting one unconditionally would silently beat a
Developer's own. It only asks whether `.env` already carries one, and it used to ask with a
`grep` of its own whose idea of an assignment line (`[[:space:]]`, no `export`) differed from
the helper's. Two parsers of one file are two answers about what it says, which is this
ticket's defect in miniature.

## Why the encoder takes which half of the URL it is filling

`pg` does not decode a connection URL uniformly, and it is not free to: `pg-connection-string`
reads `user` and `password` with `decodeURIComponent` and the database name with `decodeURI`.
`decodeURI` never unescapes a **reserved** character, so a database called `kobai db=1`
encoded strictly arrives as `kobai db%3D1` and Postgres reports a database nobody named.

So `kobai_urlencode` takes the set to preserve. The user and password get RFC 3986's
unreserved set and nothing else; the database name additionally keeps the reserved characters
`decodeURI` would refuse to give back. Both were checked against the driver rather than
against the RFC — the RFC permits several encodings of the same name and the driver accepts
one of them.

Three characters remain impossible in a database name — `/`, `?` and `#` — because each ends
the path of a URL and none can be escaped in a way `decodeURI` will undo. The user and the
password have no such limit.

## What this does not fix

**The app container's `DATABASE_URL` is still assembled by compose, and compose cannot
encode.** `docker compose up` builds `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/…`
by substitution, so a password containing `/`, `?` or `#` breaks the application while the
suite, which devbox encodes for, is unaffected. That is narrower than the defect this ADR
closes and it is written down in `.env.example` rather than left to be discovered.

Fixing it means giving compose a whole URL it does not have to build — a variable that would
have to appear in the reference Project's compose file and in what `create-kobai` generates,
which is a decision about the Project's shape rather than about this checkout's harness. It
is deliberately not taken here.

## The guardrails

`tests/the-postgres-credentials-belong-to-dot-env.test.ts` runs the hook — the lines are read
out of `devbox.json` and handed to `sh`, because the gate always runs with the result already
exported and so cannot see the rule that produced it — and then makes Postgres agree: a role
named `kobai admin=1` with a password carrying spaces, both quotes, an `=`, a `#`, a `/` and
a `?` is created, and the **harness itself** signs in as it. The same file asserts that the
password truncated at its first punctuation mark is refused, because a test that only proves
a string arrived would pass equally against a Postgres that never checked one.

It also holds the **three** copies of the fallback credentials to being one set:
`compose.yaml`'s `${POSTGRES_USER:-kobai}` defaults, the `:-kobai` defaults in the hook
itself, and the harness's fallback URL. devbox's own copy is reached by running the hook
against a checkout with nothing set at all, which is the only way those defaults are visible
— guarding two of three would let the third be left behind while the check read as though
nothing had. That is what
`tests/the-fallback-postgres-port.test.ts` does for the port. That test deliberately left the
credentials alone while they reached the harness on neither path — two agreeing literals
would have fixed nothing and read as though they had. Now that they reach it on the derived
path, the literals underneath are the port's situation exactly, and get the port's guardrail.
