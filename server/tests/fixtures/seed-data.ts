import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema/index.js";
import { generateApiKey } from "../../src/lib/api-key.js";
import { apiKeyVault } from "../../src/lib/api-key-vault.js";
import { findingIdentityOf } from "../../src/lib/vulnerability-aliases.js";

type Database = PostgresJsDatabase<typeof schema>;

/**
 * Stamp `findingIdentity` onto vulnerability seed rows, the way the OSV sync
 * does at ingest (`convertOsvRecordToVulnerability`). Tests that insert
 * `schema.vulnerabilities` directly bypass the sync — the only production
 * writer of advisory rows — so without this the stored collapse key is NULL
 * and every surface that groups or joins on it misbehaves. Wrap the rows:
 *
 *     .insert(schema.vulnerabilities).values(withFindingIdentity([...]))
 */
export function withFindingIdentity<
    T extends { vulnId: string; aliases?: string[] | null; rawData?: unknown },
>(rows: T[]): (T & { findingIdentity: string })[] {
    return rows.map((row) => ({
        ...row,
        // `upstream` lives only in `raw_data`, exactly as the sync reads it.
        findingIdentity: findingIdentityOf(row.vulnId, row.aliases ?? null, upstreamOf(row.rawData)),
    }));
}

function upstreamOf(rawData: unknown): string[] | null {
    if (!rawData || typeof rawData !== "object") return null;
    const upstream = (rawData as { upstream?: unknown }).upstream;
    return Array.isArray(upstream) ? (upstream as string[]) : null;
}

/**
 * Create a test user
 */
export interface CreateUserOptions {
  id?: string;
  name?: string;
  email?: string;
  /** The shared demo visitor (`users.demo`) — read-only everywhere. */
  demo?: boolean;
}

export async function createUser(
  db: Database,
  options: CreateUserOptions = {}
): Promise<schema.User> {
  const id = options.id || randomUUID();
  const email = options.email || `user-${id.slice(0, 8)}@test.com`;
  const name = options.name || `Test User ${id.slice(0, 8)}`;

  const [user] = await db
    .insert(schema.users)
    .values({
      id,
      email,
      name,
      demo: options.demo ?? false,
    })
    .returning();

  if (!user) throw new Error("Failed to create user");
  return user;
}

/**
 * Create a test organization
 */
export interface CreateOrganizationOptions {
  id?: string;
  name?: string;
  slug?: string;
  plan?: schema.PlanType;
  color?: schema.OrgColor;
  /** The read-only demo org (`organizations.demo`). */
  demo?: boolean;
}

export async function createOrganization(
  db: Database,
  options: CreateOrganizationOptions = {}
): Promise<schema.Organization> {
  const id = options.id || randomUUID();
  const name = options.name || `Test Org ${id.slice(0, 8)}`;
  const slug = options.slug || `test-org-${id.slice(0, 8)}`;

  const [org] = await db
    .insert(schema.organizations)
    .values({
      id,
      name,
      slug,
      plan: options.plan || "free",
      color: options.color || "blue",
      demo: options.demo ?? false,
    })
    .returning();

  if (!org) throw new Error("Failed to create organization");
  return org;
}

/**
 * Add a member to an organization
 */
export async function addOrgMember(
  db: Database,
  userId: string,
  orgId: string,
  role: schema.OrgRole = "member"
): Promise<schema.OrgMember> {
  const [member] = await db
    .insert(schema.orgMembers)
    .values({
      userId,
      orgId,
      role,
    })
    .returning();

  if (!member) throw new Error("Failed to add org member");
  return member;
}

/**
 * Create an organization with an owner
 * This is a common pattern for setting up tests
 */
export interface CreateOrgWithOwnerResult {
  user: schema.User;
  org: schema.Organization;
  membership: schema.OrgMember;
}

export async function createOrgWithOwner(
  db: Database,
  userOptions: CreateUserOptions = {},
  orgOptions: CreateOrganizationOptions = {}
): Promise<CreateOrgWithOwnerResult> {
  const user = await createUser(db, userOptions);
  const org = await createOrganization(db, orgOptions);
  const membership = await addOrgMember(db, user.id, org.id, "owner");

  return { user, org, membership };
}

/**
 * Create an organization invite directly in the database.
 * Use options.expiresAt in the past to seed an expired invite.
 */
export interface CreateOrgInviteOptions {
  email?: string;
  role?: Exclude<schema.OrgRole, "owner">;
  token?: string;
  expiresAt?: Date;
}

export async function createOrgInvite(
  db: Database,
  orgId: string,
  invitedBy: string,
  options: CreateOrgInviteOptions = {}
): Promise<schema.OrgInvite> {
  const email = (options.email || `invitee-${randomUUID().slice(0, 8)}@test.com`).toLowerCase();
  const token = options.token || (randomUUID() + randomUUID()).replace(/-/g, "");

  const [invite] = await db
    .insert(schema.orgInvites)
    .values({
      orgId,
      email,
      role: options.role || "member",
      invitedBy,
      token,
      expiresAt: options.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();

  if (!invite) throw new Error("Failed to create org invite");
  return invite;
}

/**
 * Create a test API key
 */
export interface CreateApiKeyOptions {
  name?: string;
  scopes?: string[];
  expiresAt?: Date | null;
  isActive?: boolean;
}

export interface CreateApiKeyResult {
  apiKey: schema.ApiKey;
  rawKey: string; // The actual key to use in X-API-Key header
}

export async function createApiKey(
  db: Database,
  orgId: string,
  createdBy: string,
  options: CreateApiKeyOptions = {}
): Promise<CreateApiKeyResult> {
  const { key: rawKey, keyPrefix, keyHash } = generateApiKey();

  const [apiKey] = await db
    .insert(schema.apiKeys)
    .values({
      orgId,
      createdBy,
      name: options.name || "Test API Key",
      keyPrefix,
      keyHash,
      scopes: options.scopes ?? ["sbom:write", "sbom:read", "workload:read", "workload:write"],
      isActive: options.isActive ?? true,
      expiresAt: options.expiresAt,
    })
    .returning();

  if (!apiKey) throw new Error("Failed to create API key");
  return { apiKey, rawKey };
}

/**
 * Create an `images` row.
 *
 * Cluster-scoped since ADR 0006: identity is `(clusterId, digest)`, so the
 * image belongs to the org and cluster it is created for. Tests proving
 * isolation create the same digest under two clusters and get two rows.
 */
export interface CreateImageOptions {
  id?: string;
  digest?: string;
  registry?: string | null;
  repository?: string | null;
  /** Backdate the image so GC tests can age it past the retention cutoff. */
  lastSeenAt?: Date;
}

export async function createImage(
  db: Database,
  orgId: string,
  clusterId: string,
  options: CreateImageOptions = {}
): Promise<schema.Image> {
  const id = options.id || randomUUID();
  const digest = options.digest || `sha256:${id.replace(/-/g, "").padEnd(64, "0")}`;

  const [image] = await db
    .insert(schema.images)
    .values({
      id,
      orgId,
      clusterId,
      digest,
      registry: options.registry ?? "ghcr.io",
      repository: options.repository ?? `acme/app-${id.slice(0, 8)}`,
      ...(options.lastSeenAt ? { lastSeenAt: options.lastSeenAt } : {}),
    })
    .returning();

  if (!image) throw new Error("Failed to create image");
  return image;
}

/** Create a namespace. Keyed `(clusterId, name)`. */
export interface CreateNamespaceOptions {
  id?: string;
  name?: string;
  /** `null` = not collected (RBAC); `{}` = collected and empty. Not the same. */
  labels?: Record<string, string> | null;
}

export async function createNamespace(
  db: Database,
  orgId: string,
  clusterId: string,
  options: CreateNamespaceOptions = {}
): Promise<schema.Namespace> {
  const id = options.id || randomUUID();

  const [ns] = await db
    .insert(schema.namespaces)
    .values({
      id,
      orgId,
      clusterId,
      name: options.name || `ns-${id.slice(0, 8)}`,
      labels: options.labels ?? null,
    })
    .returning();

  if (!ns) throw new Error("Failed to create namespace");
  return ns;
}

/** Create a Helm release. Keyed `(clusterId, namespace, name)`. */
export interface CreateHelmReleaseOptions {
  id?: string;
  name?: string;
  namespace?: string;
  chartName?: string | null;
  chartVersion?: string | null;
  appVersion?: string | null;
  repoUrl?: string | null;
}

export async function createHelmRelease(
  db: Database,
  orgId: string,
  clusterId: string,
  options: CreateHelmReleaseOptions = {}
): Promise<schema.HelmRelease> {
  const id = options.id || randomUUID();

  const [release] = await db
    .insert(schema.helmReleases)
    .values({
      id,
      orgId,
      clusterId,
      name: options.name || `release-${id.slice(0, 8)}`,
      namespace: options.namespace || "default",
      chartName: options.chartName ?? "app",
      chartVersion: options.chartVersion ?? "1.0.0",
      appVersion: options.appVersion ?? null,
      repoUrl: options.repoUrl ?? null,
    })
    .returning();

  if (!release) throw new Error("Failed to create helm release");
  return release;
}

/** Create a GitOps application — the delivery layer, sibling to a release. */
export interface CreateGitopsApplicationOptions {
  id?: string;
  name?: string;
  /** The **application object's** namespace, not where it deploys. */
  namespace?: string;
  tool?: schema.GitopsTool;
  repoUrl?: string | null;
  targetRevision?: string | null;
  chart?: string | null;
  path?: string | null;
  destinationNamespace?: string | null;
}

export async function createGitopsApplication(
  db: Database,
  orgId: string,
  clusterId: string,
  options: CreateGitopsApplicationOptions = {}
): Promise<schema.GitopsApplication> {
  const id = options.id || randomUUID();

  const [application] = await db
    .insert(schema.gitopsApplications)
    .values({
      id,
      orgId,
      clusterId,
      name: options.name || `app-${id.slice(0, 8)}`,
      namespace: options.namespace || "argocd",
      tool: options.tool ?? "argocd",
      repoUrl: options.repoUrl ?? null,
      targetRevision: options.targetRevision ?? null,
      chart: options.chart ?? null,
      path: options.path ?? null,
      destinationNamespace: options.destinationNamespace ?? null,
    })
    .returning();

  if (!application) throw new Error("Failed to create gitops application");
  return application;
}

/** Create a workload. `kind` is nullable — pass `null` for an unresolved owner chain. */
export interface CreateWorkloadOptions {
  id?: string;
  name?: string;
  kind?: string | null;
  releaseId?: string | null;
  /** Independent of `releaseId` — a workload commonly has both. */
  applicationId?: string | null;
  runningPods?: number | null;
  labels?: Record<string, string> | null;
}

export async function createWorkload(
  db: Database,
  orgId: string,
  namespaceId: string,
  options: CreateWorkloadOptions = {}
): Promise<schema.Workload> {
  const id = options.id || randomUUID();

  const [workload] = await db
    .insert(schema.workloads)
    .values({
      id,
      orgId,
      namespaceId,
      name: options.name || `workload-${id.slice(0, 8)}`,
      kind: options.kind === undefined ? "Deployment" : options.kind,
      releaseId: options.releaseId ?? null,
      applicationId: options.applicationId ?? null,
      runningPods: options.runningPods ?? 1,
      labels: options.labels ?? null,
    })
    .returning();

  if (!workload) throw new Error("Failed to create workload");
  return workload;
}

/**
 * Create a `workload_containers` row — the addressable unit of the workloads
 * API. Identity is `(workloadId, name, imageId)`, so two rows with the same
 * name on different images is a legal mid-rollout state, not a duplicate.
 */
export interface CreateWorkloadContainerOptions {
  id?: string;
  name?: string;
  init?: boolean;
  imageRef?: string;
  imageTag?: string | null;
  runningPods?: number | null;
}

export async function createWorkloadContainer(
  db: Database,
  orgId: string,
  workloadId: string,
  imageId: string,
  options: CreateWorkloadContainerOptions = {}
): Promise<schema.WorkloadContainer> {
  const id = options.id || randomUUID();

  const [container] = await db
    .insert(schema.workloadContainers)
    .values({
      id,
      orgId,
      workloadId,
      imageId,
      name: options.name || "app",
      init: options.init ?? false,
      imageRef: options.imageRef || `ghcr.io/acme/app:${id.slice(0, 8)}`,
      imageTag: options.imageTag === undefined ? "1.0.0" : options.imageTag,
      runningPods: options.runningPods ?? 1,
    })
    .returning();

  if (!container) throw new Error("Failed to create workload container");
  return container;
}

/**
 * The whole containment chain in one call, for the common case.
 *
 * Most tests want "an image running somewhere in this org" and do not care
 * about the namespace or workload names; spelling all four inserts out at every
 * call site is how a fixture drifts from the model it is meant to mirror.
 */
export interface SeedRunningImageOptions {
  namespace?: string;
  workloadName?: string;
  workloadKind?: string | null;
  containerName?: string;
  imageTag?: string | null;
  digest?: string;
  releaseId?: string | null;
  applicationId?: string | null;
  labels?: Record<string, string> | null;
  image?: schema.Image;
}

export interface SeedRunningImageResult {
  image: schema.Image;
  namespace: schema.Namespace;
  workload: schema.Workload;
  container: schema.WorkloadContainer;
}

export async function seedRunningImage(
  db: Database,
  orgId: string,
  clusterId: string,
  options: SeedRunningImageOptions = {}
): Promise<SeedRunningImageResult> {
  const image =
    options.image ??
    (await createImage(db, orgId, clusterId, options.digest ? { digest: options.digest } : {}));

  const namespaceName = options.namespace ?? "default";
  const existingNs = await db
    .select()
    .from(schema.namespaces)
    .where(
      and(
        eq(schema.namespaces.clusterId, clusterId),
        eq(schema.namespaces.name, namespaceName)
      )
    );
  const namespace =
    existingNs[0] ??
    (await createNamespace(db, orgId, clusterId, { name: namespaceName }));

  const workload = await createWorkload(db, orgId, namespace.id, {
    name: options.workloadName ?? "api",
    kind: options.workloadKind === undefined ? "Deployment" : options.workloadKind,
    releaseId: options.releaseId ?? null,
    applicationId: options.applicationId ?? null,
    labels: options.labels ?? null,
  });

  const container = await createWorkloadContainer(db, orgId, workload.id, image.id, {
    name: options.containerName ?? "app",
    imageTag: options.imageTag === undefined ? "1.0.0" : options.imageTag,
    imageRef: `${image.repository ?? "acme/app"}@${image.digest}`,
  });

  return { image, namespace, workload, container };
}

/**
 * Create an expired API key (for testing expiration)
 */
export async function createExpiredApiKey(
  db: Database,
  orgId: string,
  createdBy: string,
  options: Omit<CreateApiKeyOptions, "expiresAt"> = {}
): Promise<CreateApiKeyResult> {
  return createApiKey(db, orgId, createdBy, {
    ...options,
    expiresAt: new Date("2020-01-01"),
  });
}

/**
 * Create a revoked API key (for testing revocation)
 */
export async function createRevokedApiKey(
  db: Database,
  orgId: string,
  createdBy: string,
  options: Omit<CreateApiKeyOptions, "isActive"> = {}
): Promise<CreateApiKeyResult> {
  return createApiKey(db, orgId, createdBy, {
    ...options,
    isActive: false,
  });
}

/**
 * Create a test cluster
 */
export interface CreateClusterOptions {
  name?: string;
  description?: string;
}

export async function createCluster(
  db: Database,
  orgId: string,
  options: CreateClusterOptions = {}
): Promise<schema.Cluster> {
  const id = randomUUID();
  const name = options.name || `Test Cluster ${id.slice(0, 8)}`;

  const [cluster] = await db
    .insert(schema.clusters)
    .values({
      orgId,
      name,
      description: options.description || null,
    })
    .returning();

  if (!cluster) throw new Error("Failed to create cluster");
  return cluster;
}

/**
 * Create a cluster-scoped API key
 */
export async function createClusterApiKey(
  db: Database,
  clusterId: string,
  orgId: string,
  createdBy: string,
  options: Omit<CreateApiKeyOptions, "isActive"> & { isActive?: boolean; revealable?: boolean } = {}
): Promise<CreateApiKeyResult> {
  const { key: rawKey, keyPrefix, keyHash } = generateApiKey();

  const [apiKey] = await db
    .insert(schema.apiKeys)
    .values({
      orgId,
      clusterId,
      createdBy,
      name: options.name || "Cluster Scanner Key",
      keyPrefix,
      keyHash,
      // Stored the way the repository stores it; `revealable: false` seeds a
      // pre-vault row (hash only) for the tests that need one.
      keyCiphertext: options.revealable === false ? null : apiKeyVault.encrypt(rawKey, keyHash),
      scopes: options.scopes ?? ["sbom:write"],
      isActive: options.isActive ?? true,
    })
    .returning();

  if (!apiKey) throw new Error("Failed to create cluster API key");
  return { apiKey, rawKey };
}

/**
 * Insert a minimal SBOM row directly into the database.
 * Useful for seeding limit/history tests without going through the HTTP upload flow.
 */
export interface CreateSbomOptions {
    imageId: string;
    createdAt?: Date;
}

export async function createSbom(
    db: Database,
    options: CreateSbomOptions,
): Promise<schema.Sbom> {
    const sha = `sha256-${randomUUID().replace(/-/g, "")}`;
    const [sbom] = await db
        .insert(schema.sboms)
        .values({
            imageId: options.imageId,
            format: "cyclonedx",
            sbomSha256: sha,
            specVersion: "1.6",
            ...(options.createdAt ? { createdAt: options.createdAt } : {}),
        })
        .returning();

    if (!sbom) throw new Error("Failed to create sbom");
    return sbom;
}

/**
 * Seed a complete test scenario with org, user, cluster, and cluster-scoped API key
 */
export interface SeedTestScenarioResult extends CreateOrgWithOwnerResult {
  cluster: schema.Cluster;
  apiKey: CreateApiKeyResult;
}

export async function seedTestScenario(
  db: Database,
  userOptions: CreateUserOptions = {},
  orgOptions: CreateOrganizationOptions = {}
): Promise<SeedTestScenarioResult> {
  const { user, org, membership } = await createOrgWithOwner(
    db,
    userOptions,
    orgOptions
  );

  const cluster = await createCluster(db, org.id);
  const apiKey = await createClusterApiKey(db, cluster.id, org.id, user.id);

  return { user, org, membership, cluster, apiKey };
}
