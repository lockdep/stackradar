---
name: sbom-cyclonedx
description: >-
  Domain knowledge for SBOM parsing, CycloneDX validation, component extraction,
  and PURL handling. Use when working with SBOM uploads, CycloneDX schemas,
  component data, PURL strings, or the sbom.service.
---

# SBOM & CycloneDX Domain Knowledge

## Key Concepts

| Term | Meaning |
|------|---------|
| **SBOM** | Software Bill of Materials — a manifest of all software components |
| **CycloneDX** | Primary SBOM format used in this project (spec v1.6) |
| **SPDX** | Alternate SBOM format — detected but not fully implemented |
| **PURL** | Package URL (`pkg:npm/%40angular/core@16.0.0`) — unique component identifier |
| **BOM** | Bill of Materials — the CycloneDX root object |
| **bom-ref** | Internal reference ID linking components to dependency graph |

## Libraries

| Package | Usage |
|---------|-------|
| `@cyclonedx/cyclonedx-library` | `Models`, `Enums`, `Spec.Version.v1dot6`, `Serialize.JsonSerializer`, `Validation.JsonValidator` |
| `packageurl-js` | `PackageURL.fromString(purl)` for parsing PURLs |
| `ajv` | Schema validation against `bom-1.6.schema.json` |

## SBOM Upload Flow

1. **Controller** (`server/src/controllers/sbom.controller.ts`): parse query (`projectId`, `isCurrent`), verify project ownership, validate with AJV, call service
2. **Service** (`server/src/services/sbom.service.ts`):
   - `detectFormat(data)` — checks `bomFormat` or `spdxVersion`
   - `computeSbomHash(data)` — SHA-256 for deduplication
   - `parseCycloneDxJson(data)` — builds `Models.Bom`
   - `extractTransitiveDependencies(raw)` — collects bom-refs in `dependsOn`
   - `flattenParsedComponents(raw, transitiveDeps)` — flat list with `isDirect` flag
3. **Transaction**: create SBOM row, batch-insert components (chunks of 500), insert hashes/refs/properties/licenses, store dependency graph

## Component Sources in CycloneDX

Components are extracted from multiple locations in the BOM:
- `raw.components[]` — top-level
- `raw.metadata.component` — root component
- `raw.metadata.tools.components[]` — build tools
- `raw.components[].components[]` — nested (recursive)

## Component Data Model

```typescript
// DB insert shape (server/src/db/schema/components.ts)
NewComponent {
  sbomId, purl, name, version, type, groupName,
  publisher, author, description, cpe, bomRef, isDirect, scope
}
```

Related tables: `component_hashes`, `component_external_refs`, `component_properties`, `component_licenses`, `component_dependencies`.

## PURL Handling

- **Parse**: `PackageURL.fromString(purl)` with try/catch, returns `undefined` on failure
- **Base PURL**: strip version/qualifiers/subpath — used for vulnerability matching (`osv-sync/parser.ts: toBasePurl`)
- **Store**: as string via `mc.purl?.toString() ?? null`

## Validation

- **AJV validator** (`server/src/validators/cyclonedx.validator.ts`): validates against `bom-1.6.schema.json`, `spdx.schema.json`, `jsf-0.82.schema.json`
- **Supported versions**: `["1.6"]`
- **Error format**: `formatValidationErrors(errors)` — human-readable, max 3 errors

## Conventions

| Pattern | Detail |
|---------|--------|
| Batch size | `BATCH_CHUNK_SIZE = 500` in `component.repository.ts` |
| No cross-SBOM dedup | Each SBOM gets its own component rows |
| `isCurrent` flag | One current SBOM per project; new upload can replace it |
| Raw JSON storage | `sboms.rawJson` holds full document for reconstruction |
| Hash dedup | `(projectId, sbomSha256)` unique index prevents duplicates |
| Scope values | `required | optional | excluded` per CycloneDX spec |

## Schemas

- **Zod** (`server/src/schemas/sbom.schema.ts`): `sbomIdParamSchema`, `uploadSbomQuerySchema`
- **CycloneDX JSON** (`server/src/schemas/cyclonedx-specifications/`): official 1.6 schemas
