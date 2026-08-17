# Fulfilment strategies are an open set, and Fulfilment is its own entity

A Variant points at a named **Fulfilment Strategy**, registered by Core or by a Plugin,
which answers Core's questions: does this ship, does it consume stock, does it have a lead
time. Core ships `physical` and `digital`. **Made-to-order is a Plugin.** Separately, an
Order has **many Fulfilments** — Fulfilment is its own entity, not a status on the Order.

## Why not an enum

A `type` enum on Variant is a closed set, and a closed set is exactly what forces a Core
change the first time someone wants rentals, services, or subscriptions — the failure mode
ADR-0003 exists to prevent. `requires_shipping` and `tracks_inventory` are therefore
questions *answered by* a strategy, not flags stored on a Variant.

## Why Fulfilment is separate

A mixed cart — a poster, a PDF, and a rush print job — becomes one Order whose parts ship
on entirely different timelines, some never shipping at all. Modelling fulfilment state as a
column on Order forces a single lifecycle onto parts that do not share one, and is an
ADR-0009-class mistake: cheap now, unfixable once there is order history.

## Consequences

Made-to-order being a Plugin means kobai's own first store is again the proof of the
extension model, alongside ADR-0013. If made-to-order cannot be expressed as a strategy
Plugin, the strategy interface is wrong.
