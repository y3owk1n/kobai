# The Admin ships in the Project's container and gets no private API

The Admin is served by the Project's own Node process at a path — one Project, one
container — and is built as an independent SPA that consumes **only the public API**. Core
grants the Admin no privileged back door.

## Why one container

It matches kobai's goal that a Project deploys with `docker compose up`, it removes CORS
configuration from the setup path entirely, and one deployable per Project stays consistent
with ADR-0005's single-tenant model.

## Why no private API

This is the load-bearing half. Under ADR-0002 the API *is* the product for a Developer
building a storefront. Every capability the Admin reaches through a private channel is a
capability the public API is missing and nobody has noticed. Forcing the Admin onto the
same surface a Developer uses means the API is continuously dogfooded by the most demanding
consumer we have, and gaps surface as our own pain rather than as someone's bug report.

## Consequences

Admin-only concerns — bulk operations, cross-entity search, anything the Admin needs and a
storefront doesn't — must be designed as legitimate public API surface, not smuggled in.
Where that feels wrong, the correct response is to question the feature, not to add the
back door.
