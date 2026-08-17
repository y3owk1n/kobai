# Postgres-backed jobs, pluggable storage, in-process worker

Background work runs on a Postgres-backed queue. Media storage is a pluggable driver
defaulting to local disk, with an S3-compatible driver shipped. The worker runs in the
application process. `docker compose up` is therefore **Postgres, the app, and a volume**.

## Why not Redis, and why not required S3

Deploying easily with Docker is a stated product goal rather than a convenience. Redis would
double the infrastructure of a deployment in exchange for retries and scheduling that
Postgres already provides. A required S3 dependency would pull minio into compose and make
the first run a three-service affair. Both are the right call at larger scale and neither is
the right default.

## A consistency check worth recording

A storage driver is *dependency substitution*, already one of ADR-0003's five Extension
Points. That it needed no new extension mechanism is evidence the five are the right five —
and the same test should be applied to future pluggable concerns before adding a sixth.

## Consequences

The in-process worker means a runaway job competes with request latency. This is accepted,
on the condition that the worker is written so it can be started alone — making the eventual
split a deploy change rather than a rewrite.
