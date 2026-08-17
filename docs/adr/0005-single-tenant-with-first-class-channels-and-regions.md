# Single-tenant, with Channels and Regions first-class

One deployment serves exactly one Store. kobai is not multi-tenant and will not scope
queries by tenant. Variation *within* a Store — several storefronts, several geographies,
several currencies — is modelled from day one as **Channel** and **Region**, which are not
multi-tenancy and must not be confused with it.

Multi-tenancy is a tax on every query, every Plugin, and every migration, permanently. It
is both very hard to add safely and very hard to remove, so it needs a strong reason, and
"agencies serve many clients" is not one when a Project is a Docker deployable and
deploying per client is trivial. Channel and Region, by contrast, are nearly free up front
and genuinely agonising to retrofit, because they reach into catalog, pricing, tax,
shipping, and inventory simultaneously.

## Consequences

- **Store is a singleton** — the commercial identity of the deployment. It is never a
  scoping key, never a foreign key on other entities, and never appears in a `where`
  clause. If it starts to, multi-tenancy is being smuggled in.
- Vendure overloads its `Channel` to mean both sales channel and tenant boundary, and it
  is a known source of confusion. kobai's Channel means sales channel only.
