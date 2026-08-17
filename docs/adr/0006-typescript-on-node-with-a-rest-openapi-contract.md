# TypeScript on Node, with a REST/OpenAPI contract

kobai is TypeScript on Node. Its API contract is REST described by OpenAPI, shipped
alongside a generated, fully-typed TypeScript client. GraphQL is deferred to a possible
Plugin. tRPC is rejected outright.

## Considered options

- **GraphQL** (Vendure, Saleor) — genuinely better at plugin-extensible API surface, which
  is exactly why both chose it, and this is the strongest argument against this decision.
  Deferred because it is a heavy commitment that works against ADR-0003's goal of a small
  boring stable surface, and because OpenAPI plus code generation delivers most of the
  developer experience at a fraction of the complexity. If plugin-extensible API surface
  later proves central, this is the decision to revisit first.
- **tRPC** — the best possible TypeScript DX, and a category error here. It locks every
  consumer into TypeScript, which contradicts ADR-0002: a headless engine exists so that
  any storefront in any language can consume it.

## Consequences

The generated typed client is a first-class deliverable, not a convenience. Per ADR-0002
the API *is* the product for a Developer building a storefront, so an untyped or
hand-maintained client would undercut the entire DX claim.
