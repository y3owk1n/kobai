import type { OpenApiDescription } from "@kobai/client";

/**
 * This deployment's own OpenAPI description, read rather than assumed.
 *
 * **The document is an open object and that is deliberate** (ADR-0080): an OpenAPI description
 * is a recursive schema kobai does not own, so `@kobai/client` types it as
 * `{ [key: string]: unknown }` and hands the whole thing over untouched. Everything below is
 * the Admin narrowing that value for itself, one field at a time, because the alternative is a
 * second, worse copy of a specification in a tree `kobai-upgrade` can never reach.
 *
 * **Nothing here is bundled.** The generated client is types and TypeScript erases every one of
 * them, so the Admin holds no description at build time at all — which is the whole reason
 * `GET /admin/openapi.json` exists. Importing `@kobai/core/openapi.json` would be a package's
 * build artifact standing in for this server's answer, and it is banned outright besides
 * (`tests/admin-uses-only-the-public-api.test.ts`).
 *
 * **Every reader below answers `undefined` rather than throwing.** A document that is missing a
 * field, or carries one of the wrong type, is a deployment describing itself oddly — not a
 * reason to blank a screen whose whole subject is that document. So a malformed corner renders
 * as an absence and the rest of the operation still renders.
 */

/** The keys of a path item that are operations. Everything else there describes the path. */
const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

/** One operation, as much of it as this Admin reads. */
export type Operation = {
  /**
   * What the address names this operation by — `GET /admin/products`.
   *
   * The method and the path, because an OpenAPI document promises no `operationId` and kobai's
   * carries none. It is what `?operation=` holds, so it is a Developer-legible thing to find in
   * a link a colleague was sent rather than an opaque token.
   */
  readonly key: string;
  /** Upper case, the way a request line spells it. */
  readonly method: string;
  /** The templated path, exactly as the document spells it: `/admin/products/{id}`. */
  readonly path: string;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  /** The security schemes this operation accepts, by the name the document knows each by. */
  readonly securitySchemes: readonly string[];
  /** The operation object itself, for the readers below that go deeper into it. */
  readonly raw: Record<string, unknown>;
};

/** A run of operations the list draws under one heading — see {@link groupOperations}. */
export type OperationGroup = {
  /** The path prefix they share, which is the heading: `/admin/products`, `/health`. */
  readonly prefix: string;
  readonly operations: readonly Operation[];
};

/** The value as an object, or `undefined` where it is anything else — an array included. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

/** The object at `key`, or `undefined` where there is none or it is not an object. */
export function objectAt(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  return asObject(asObject(value)?.[key]);
}

/** The string at `key`, or `undefined` where there is none or it is not a string. */
export function stringAt(value: unknown, key: string): string | undefined {
  const held = asObject(value)?.[key];
  return typeof held === "string" ? held : undefined;
}

/** The array at `key`, or an empty one where there is none or it is not an array. */
export function arrayAt(value: unknown, key: string): readonly unknown[] {
  const held = asObject(value)?.[key];
  return Array.isArray(held) ? held : [];
}

/**
 * Every operation the document carries, in the order it carries them.
 *
 * **The document's order and not an order of this Admin's**, which is how kobai's routes are
 * registered and therefore how the surface reads from the outside. Sorting alphabetically would
 * scatter the four Cart operations that belong together and would be this screen inventing a
 * taxonomy for a document that already has one.
 *
 * A path item may also hold `parameters`, `summary` and `$ref`, none of which is an operation,
 * so the methods are named rather than taken to be every key.
 */
export function operationsIn(document: OpenApiDescription): readonly Operation[] {
  const paths = objectAt(document, "paths");
  if (paths === undefined) return [];

  return Object.entries(paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const raw = objectAt(item, method);
      if (raw === undefined) return [];
      return [
        {
          key: `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          summary: stringAt(raw, "summary"),
          description: stringAt(raw, "description"),
          securitySchemes: arrayAt(raw, "security").flatMap((requirement) =>
            typeof requirement === "object" && requirement !== null
              ? Object.keys(requirement)
              : [],
          ),
          raw,
        },
      ];
    }),
  );
}

/**
 * The operations a typed word narrows to — its method, its path, or what it does.
 *
 * **Three fields rather than the path alone**, because the two questions a Developer arrives
 * with are different: *where does the Cart line-item route live* is answered by the path, and
 * *which route signs a Merchant in* is answered by the summary, which is the only place the
 * word `sign` appears anywhere on this surface. The `description` is deliberately **not**
 * searched: it is a paragraph on most operations, so a word from one would match half the
 * surface and the narrowing would stop meaning anything.
 *
 * Case-insensitive and a plain substring, because that is what a reader typing `carts` means.
 * Nothing is reordered by how well it matched — the list keeps the document's order, so an
 * operation stays where it was rather than moving under the cursor as a word is typed.
 */
export function operationsMatching(
  operations: readonly Operation[],
  typed: string,
): readonly Operation[] {
  const wanted = typed.trim().toLowerCase();
  if (wanted === "") return operations;

  return operations.filter((operation) =>
    `${operation.key} ${operation.summary ?? ""}`.toLowerCase().includes(wanted),
  );
}

/**
 * The operations under one heading each, derived from the paths rather than from a list here.
 *
 * kobai's description carries no `tags`, so there is no grouping in the document to read — and
 * a table of resource names written down in this Admin would be exactly the closed set
 * ADR-0067 rules out, wrong on the first Core that adds a route. What the paths do carry is the
 * shape a Developer already reasons about: a surface and a resource. So the heading is the path
 * up to its second segment — `/admin/products`, `/store/carts` — and where that segment is a
 * template parameter, as `/media/{key}` is, the surface alone, because `/media/{key}` names one
 * resource rather than a family of them.
 *
 * **Runs rather than buckets.** Operations keep the document's order and a group is a run of
 * neighbours sharing a prefix, so nothing is reordered to be grouped — which also means a
 * description that interleaves two resources draws two headings, and says so, instead of
 * silently gathering them.
 */
export function groupOperations(
  operations: readonly Operation[],
): readonly OperationGroup[] {
  const groups: { prefix: string; operations: Operation[] }[] = [];

  for (const operation of operations) {
    const prefix = groupPrefixOf(operation.path);
    const last = groups.at(-1);
    if (last?.prefix === prefix) last.operations.push(operation);
    else groups.push({ prefix, operations: [operation] });
  }

  return groups;
}

/** One parameter an operation takes, wherever the document says it goes. */
export type Parameter = {
  readonly name: string;
  /** `path`, `query`, `header` or `cookie` — the document's own word. */
  readonly in: string;
  readonly required: boolean;
  readonly description: string | undefined;
  readonly schema: unknown;
};

/** The parameters an operation declares, in the order it declares them. */
export function parametersOf(operation: Operation): readonly Parameter[] {
  return arrayAt(operation.raw, "parameters").flatMap((parameter) => {
    const name = stringAt(parameter, "name");
    if (name === undefined) return [];
    return [
      {
        name,
        in: stringAt(parameter, "in") ?? "query",
        required: asObject(parameter)?.required === true,
        description: stringAt(parameter, "description"),
        schema: objectAt(parameter, "schema"),
      },
    ];
  });
}

/** A body an operation takes or answers with, in one media type. */
export type Body = {
  readonly mediaType: string;
  readonly schema: unknown;
};

/**
 * The body a request body or a response carries, or `undefined` where it carries none.
 *
 * The **first** media type the document lists, because kobai declares one apiece and an
 * operation offering a choice is a shape this screen has no way to let a Developer pick between
 * yet. `POST /admin/media` is the one that is not JSON, and it says `multipart/form-data` here
 * rather than pretending otherwise.
 *
 * One reader for the two callers, on the extract-on-the-second rule the components in this
 * Admin already follow: a request body and a response are the same three lines of OpenAPI, and
 * two copies is where one of them quietly stops handling a body that has no content at all.
 */
function bodyOf(holder: Record<string, unknown> | undefined): Body | undefined {
  const content = objectAt(holder, "content");
  const [mediaType] = Object.keys(content ?? {});
  if (content === undefined || mediaType === undefined) return undefined;
  return { mediaType, schema: objectAt(content, mediaType)?.schema };
}

/** The body this operation takes, or `undefined` where it takes none. */
export function requestBodyOf(operation: Operation): Body | undefined {
  return bodyOf(objectAt(operation.raw, "requestBody"));
}

/** One response an operation declares — an answer or a refusal, told apart by its status. */
export type DeclaredResponse = {
  readonly status: string;
  readonly description: string | undefined;
  readonly body: Body | undefined;
};

/**
 * Every response the operation declares, in status order.
 *
 * **In the document's order, which for kobai is ascending status**, and sorted here anyway so
 * that a description written in some other order still reads as a Developer expects. A response
 * with no body is kept — `204` is an answer and saying nothing is what it says.
 */
export function responsesOf(operation: Operation): readonly DeclaredResponse[] {
  const responses = objectAt(operation.raw, "responses") ?? {};

  return Object.entries(responses)
    .map(([status, response]) => ({
      status,
      description: stringAt(response, "description"),
      body: bodyOf(asObject(response)),
    }))
    .sort((one, other) => one.status.localeCompare(other.status));
}

/**
 * Whether this status is a refusal.
 *
 * The status and not the schema, because that is the line a caller acts on: everything below
 * 400 is a shape to read and everything at or above it is a rule to handle. A status the
 * document spells as a range — `4XX` — is a refusal too, which is why this reads the first
 * character rather than parsing a number.
 */
export function isRefusal(status: string): boolean {
  return status.startsWith("4") || status.startsWith("5");
}

/** The component name a `$ref` points at, or `undefined` for a schema written out in place. */
export function refNameOf(schema: unknown): string | undefined {
  const ref = stringAt(schema, "$ref");
  return ref?.startsWith("#/components/schemas/")
    ? ref.slice("#/components/schemas/".length)
    : undefined;
}

/**
 * How far {@link flattenSchema} and {@link typeNameOf} walk before they stop.
 *
 * **Both of them can recur through a document rather than through a caller**, which is the
 * difference between them and the tree the Playground draws: the screen stops on a component it
 * has already expanded, and neither of these has a caller's path to check against. So each
 * carries a bound of its own, and neither bound is reachable by anything kobai serves — what it
 * costs a pathological document is a name that reads `object`, and what it saves is the tab.
 */
const DEEPEST_FOLD = 8;

/** A schema with its `$ref` followed and its `allOf` members folded together. */
export type FlatSchema = {
  /** The component this came from, when it came from one — `CreateVariantRequest`. */
  readonly name: string | undefined;
  /** The schema itself, `allOf` merged. */
  readonly schema: Record<string, unknown>;
  /** The alternatives, where the schema is a `oneOf` or an `anyOf`. */
  readonly alternatives: readonly unknown[];
};

/**
 * One schema, resolved far enough to render: the `$ref` followed, the `allOf` folded in.
 *
 * **`allOf` has to be folded rather than rendered**, because that is how an intersection
 * arrives: `ProductDetail` is `Product & { … }` and `fulfilment` is a `$ref` beside a lone
 * `description`, so a renderer that drew each member as a heading would turn every intersection
 * into two half-schemas and every annotated reference into a schema with no fields.
 *
 * `oneOf` and `anyOf` are the opposite and are handed back untouched, because the alternatives
 * are the answer — `MigrationState` is four different shapes and merging them would describe a
 * shape kobai never sends.
 *
 * **The `allOf` fold is depth-bounded, and that is a hang rather than a truncation it is
 * guarding against.** A component whose `allOf` reaches itself would recur for ever, and this
 * module's promise is that a document describing itself oddly renders as an absence rather than
 * taking the tab down. kobai's own description nests two members deep at the most, so the bound
 * is invisible to it — see {@link DEEPEST_FOLD}.
 */
export function flattenSchema(
  document: OpenApiDescription,
  schema: unknown,
  depth = 0,
): FlatSchema {
  const name = refNameOf(schema);
  const schemas = objectAt(objectAt(document, "components"), "schemas");
  const resolved =
    name === undefined ? (asObject(schema) ?? {}) : (objectAt(schemas, name) ?? {});

  const members = depth >= DEEPEST_FOLD ? [] : arrayAt(resolved, "allOf");
  if (members.length === 0) {
    return {
      name,
      schema: resolved as Record<string, unknown>,
      alternatives: [...arrayAt(resolved, "oneOf"), ...arrayAt(resolved, "anyOf")],
    };
  }

  const merged: Record<string, unknown> = { ...resolved };
  delete merged.allOf;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const member of members) {
    const flat = flattenSchema(document, member, depth + 1);
    Object.assign(properties, objectAt(flat.schema, "properties") ?? {});
    for (const one of arrayAt(flat.schema, "required")) {
      if (typeof one === "string") required.push(one);
    }
    for (const [key, value] of Object.entries(flat.schema)) {
      if (key === "properties" || key === "required" || key === "allOf") continue;
      merged[key] ??= value;
    }
  }

  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.length > 0) merged.required = [...new Set(required)];

  return {
    name:
      name ?? members.map((member) => refNameOf(member)).find((one) => one !== undefined),
    schema: merged,
    alternatives: [...arrayAt(merged, "oneOf"), ...arrayAt(merged, "anyOf")],
  };
}

/** One field of an object schema. */
export type SchemaProperty = {
  readonly name: string;
  readonly required: boolean;
  readonly schema: unknown;
};

/** The fields an object schema declares, with the ones it insists on marked. */
export function propertiesOf(schema: Record<string, unknown>): readonly SchemaProperty[] {
  const properties = objectAt(schema, "properties") ?? {};
  const required = new Set(
    arrayAt(schema, "required").filter((one): one is string => typeof one === "string"),
  );

  return Object.entries(properties).map(([name, value]) => ({
    name,
    required: required.has(name),
    schema: value,
  }));
}

/** The types a schema declares, which is a list wherever the field is nullable. */
export function typesOf(schema: Record<string, unknown>): readonly string[] {
  const declared = schema.type;
  return (Array.isArray(declared) ? declared : [declared]).filter(
    (one): one is string => typeof one === "string",
  );
}

/** The values a schema closes itself to, which is what a refusal's `reason` carries. */
export function enumOf(schema: Record<string, unknown>): readonly string[] {
  return arrayAt(schema, "enum").map((one) => String(one));
}

/**
 * What a schema is, in as few words as says the true thing — `string`, `array of Media`.
 *
 * The component's own name where there is one, because `Media` tells a Developer more than
 * `object` does and is the word the rest of the description uses. `type` may be a list, which
 * is how a nullable field is written, so both halves are said rather than the first one.
 *
 * It walks a document rather than a caller — through `oneOf` and into what an array holds — so
 * it carries {@link DEEPEST_FOLD} for the reason `flattenSchema` does: a `$ref` that reaches
 * itself through either would otherwise never come back.
 */
export function typeNameOf(
  document: OpenApiDescription,
  schema: unknown,
  depth = 0,
): string {
  if (depth >= DEEPEST_FOLD) return "any";

  const flat = flattenSchema(document, schema);
  if (flat.alternatives.length > 0) {
    const each = flat.alternatives.map((one) => typeNameOf(document, one, depth + 1));
    return `one of ${each.join(", ")}`;
  }

  const types = typesOf(flat.schema);

  if (types.includes("array")) {
    const items = typeNameOf(document, flat.schema.items, depth + 1);
    return types.includes("null") ? `array of ${items}, or null` : `array of ${items}`;
  }

  if (flat.name !== undefined) {
    return types.includes("null") ? `${flat.name}, or null` : flat.name;
  }

  return types.length > 0 ? types.join(" or ") : "any";
}

/** A credential an operation accepts, as the document describes it. */
export type SecurityScheme = {
  readonly name: string;
  readonly description: string | undefined;
};

/**
 * Which credentials open this operation, read from the document's own security schemes.
 *
 * An operation naming none is open — kobai's description declares no document-wide `security`,
 * so there is nothing for an operation to be inheriting from. That is a real answer here rather
 * than a gap: `GET /health` and `GET /media/{key}` are open on purpose (ADR-0078).
 */
export function securitySchemesOf(
  document: OpenApiDescription,
  operation: Operation,
): readonly SecurityScheme[] {
  const declared = objectAt(objectAt(document, "components"), "securitySchemes");

  return operation.securitySchemes.map((name) => ({
    name,
    description: stringAt(objectAt(declared, name), "description"),
  }));
}

function groupPrefixOf(path: string): string {
  const [surface, resource] = path.replace(/^\//, "").split("/");
  if (surface === undefined) return path;
  if (resource === undefined || resource.startsWith("{")) return `/${surface}`;
  return `/${surface}/${resource}`;
}

/**
 * A body shaped the way the request schema says it should be, for the field to start from.
 *
 * **A starting point and never a validation** (ADR-0081). Nothing checks what a Developer then
 * types, and a body the schema would refuse is exactly what somebody comes here to send: the
 * refusal is the documentation, made by the authority that owns the rule.
 *
 * Two decisions about what it puts in the box:
 *
 * - **The required fields and only those.** An optional field seeded with a placeholder is a
 *   value a Developer did not choose to send, and several routes in kobai *replace* rather than
 *   merge what they are given (ADR-0062) — so a seeded `metadata: {}` would quietly empty a bag
 *   nobody meant to touch. A body whose fields are all optional therefore seeds as `{}`, which
 *   is a real request and the shortest true answer.
 * - **Nothing is invented.** A string starts empty, a number at zero, a list as a list — and
 *   where the schema closes itself to a set of words, the **first** of them, because that is a
 *   value kobai named rather than one this Admin made up.
 *
 * It stops on a component already expanded on the way down, which is what terminates a
 * recursive document, with {@link DEEPEST_FOLD} as the backstop behind that — the same pair
 * every reader in this module uses.
 */
export function seedBody(document: OpenApiDescription, schema: unknown): string {
  return `${JSON.stringify(sampleOf(document, schema, []), null, 2)}\n`;
}

/** One value shaped like its schema, as far down as the schema goes. */
function sampleOf(
  document: OpenApiDescription,
  schema: unknown,
  seen: readonly string[],
): unknown {
  if (seen.length >= DEEPEST_FOLD) return null;

  const flat = flattenSchema(document, schema);
  // An alternative is a shape kobai really sends, so the first of them is a real answer; making
  // one up out of all of them would be a shape it never sends.
  const chosen =
    flat.alternatives.length > 0 ? flattenSchema(document, flat.alternatives[0]) : flat;
  if (chosen.name !== undefined && seen.includes(chosen.name)) return null;

  const values = enumOf(chosen.schema);
  if (values.length > 0) return values[0];

  const types = typesOf(chosen.schema);
  if (types.includes("array")) return [];
  if (types.includes("string")) return "";
  if (types.includes("integer") || types.includes("number")) return 0;
  if (types.includes("boolean")) return false;

  const deeper = chosen.name === undefined ? seen : [...seen, chosen.name];
  const fields = propertiesOf(chosen.schema).filter((field) => field.required);
  if (fields.length > 0 || types.includes("object")) {
    return Object.fromEntries(
      fields.map((field) => [field.name, sampleOf(document, field.schema, deeper)]),
    );
  }

  return null;
}
