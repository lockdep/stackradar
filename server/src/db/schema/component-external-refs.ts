import { pgTable, uuid, varchar, text, index } from "drizzle-orm/pg-core";
import { components } from "./components.js";

/**
 * External reference types per CycloneDX spec
 * @see https://cyclonedx.org/docs/1.6/json/#components_items_externalReferences_items_type
 */
export type ExternalRefType =
    | "vcs"              // Version control system
    | "issue-tracker"    // Issue or defect tracking system
    | "website"          // Project website
    | "advisories"       // Security advisories
    | "bom"              // Bill of materials
    | "mailing-list"     // Mailing list or discussion group
    | "social"           // Social media account
    | "chat"             // Real-time chat platform
    | "documentation"    // Documentation, guides, or tutorials
    | "support"          // Community or commercial support
    | "source-distribution"  // Direct link to source code archive
    | "distribution"     // Direct link to component artifact
    | "distribution-intake"  // Where components are submitted
    | "license"          // License file
    | "build-meta"       // Build metadata
    | "build-system"     // Build system reference
    | "release-notes"    // Release notes
    | "security-contact" // Security contact info
    | "model-card"       // Machine learning model card
    | "log"              // Changelogs
    | "configuration"    // Configuration info
    | "evidence"         // Digital evidence
    | "formulation"      // Build/CI formulation
    | "attestation"      // Attestation/verification
    | "threat-model"     // Threat model
    | "adversary-model"  // Adversary model
    | "risk-assessment"  // Risk assessment
    | "vulnerability-assertion"  // Vulnerability disclosure/assertion
    | "exploitability-statement" // Exploitability statement
    | "pentest-report"   // Penetration test report
    | "static-analysis-report"   // SAST report
    | "dynamic-analysis-report"  // DAST report
    | "runtime-analysis-report"  // RAST/IAST report
    | "component-analysis-report" // SCA report
    | "maturity-report"  // Maturity assessment
    | "certification-report"     // Certification report
    | "codified-infrastructure"  // IaC files
    | "quality-metrics"  // Quality metrics
    | "poam"             // Plan of action & milestones
    | "electronic-signature"     // Digital signature
    | "rfc-9116"         // RFC 9116 security.txt
    | "other";           // Other type

/**
 * Stores external references for components.
 * Links to VCS repositories, documentation, issue trackers, etc.
 */
export const componentExternalRefs = pgTable("component_external_refs", {
    id: uuid("id").primaryKey().defaultRandom(),
    componentId: uuid("component_id").notNull().references(() => components.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 50 }).notNull().$type<ExternalRefType>(),
    // URL length is unbounded in practice. `text` matches Postgres'
    // varchar(n) storage characteristics without the truncation risk that
    // would surface as a confusing "value too long" error during SBOM
    // ingest. See docs/db-audit/P3-polish.md § P3-12.
    url: text("url").notNull(),
    comment: text("comment"),
}, (table) => [
    index("component_external_refs_component_id_idx").on(table.componentId),
]);

export type NewComponentExternalRef = typeof componentExternalRefs.$inferInsert;
