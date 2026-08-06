export type MemoryScope = 'private' | 'workspace';
export type MemoryKind = 'profile' | 'fact' | 'concept' | 'entity' | 'decision'
  | 'lesson' | 'source-summary' | 'synthesis' | 'procedure-ref';
export type MemoryStatus = 'proposed' | 'active' | 'conflicted' | 'superseded' | 'expired';
export type MemoryConfidence = 'user-confirmed' | 'source-grounded' | 'inferred';
export type MemoryTrust = 'owner' | 'trusted' | 'external' | 'public' | 'system';

export interface RunMemoryContext {
  profileId: string;
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  allowEpisodeEvidence?: boolean;
  cause?: {
    eventId?: string;
    taskId?: string;
    trust: MemoryTrust;
    source: string;
  };
}

export interface SourceRef {
  type: 'file' | 'session' | 'mimi-event' | 'user-explicit' | 'memory';
  id: string;
  digest: string;
  occurredAt: string;
  trust: MemoryTrust;
}

export interface MemoryRef {
  scope: MemoryScope;
  id: string;
  profileId?: string;
}

export type MemoryPageLayer = 'L1' | 'L2';

export interface MemoryRelationFacet {
  kind: string;
  target: MemoryRef;
}

export interface MemoryTimeFacet {
  occurredAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
}

export interface MemoryTypedFacets {
  kind: MemoryKind;
  entities: string[];
  relations: MemoryRelationFacet[];
  time: MemoryTimeFacet;
  sources: string[];
}

export interface MemoryFacetInput {
  entities?: string[];
  relations?: MemoryRelationFacet[];
  time?: Partial<MemoryTimeFacet>;
}

interface MemoryPageMetadataBase {
  id: string;
  canonicalKey?: string;
  title: string;
  kind: MemoryKind;
  scope: MemoryScope;
  profileId: string | null;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  aliases: string[];
  tags: string[];
  sourceRefs: SourceRef[];
  validFrom: string | null;
  validUntil: string | null;
  lastVerifiedAt?: string | null;
  refreshAfter?: string | null;
  mergedInto?: string | null;
  supersedes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LegacyMemoryPageMetadata extends MemoryPageMetadataBase {
  schemaVersion: 1;
}

export interface LayeredMemoryPageMetadata extends MemoryPageMetadataBase {
  schemaVersion: 2;
  layer: MemoryPageLayer;
  facets: MemoryTypedFacets;
  derivedFrom: MemoryRef[];
}

export type MemoryPageMetadata = LegacyMemoryPageMetadata | LayeredMemoryPageMetadata;

export function memoryEvidenceId(source: SourceRef): string {
  return `${source.type}:${source.id}:${source.digest}`;
}

export function layeredMemoryFields(input: {
  layer?: MemoryPageLayer;
  kind: MemoryKind;
  sourceRefs: SourceRef[];
  facets?: MemoryFacetInput;
  derivedFrom?: MemoryRef[];
  validFrom?: string | null;
  validUntil?: string | null;
}): Pick<LayeredMemoryPageMetadata, 'schemaVersion' | 'layer' | 'facets' | 'derivedFrom'> {
  const layer = input.layer ?? 'L1';
  const derivedFrom = input.derivedFrom ?? [];
  if (layer === 'L1' && derivedFrom.length > 0) throw new Error('L1 Memory Atom 不能派生自其他结论');
  if (layer === 'L2' && derivedFrom.length === 0) throw new Error('L2 Scene/Topic 必须引用至少一个 L1/L2 结论');
  return {
    schemaVersion: 2,
    layer,
    derivedFrom: derivedFrom.map((ref) => ({ ...ref })),
    facets: {
      kind: input.kind,
      entities: [...new Set(input.facets?.entities?.map((entity) => entity.trim()).filter(Boolean) ?? [])],
      relations: (input.facets?.relations ?? []).map((relation) => ({
        kind: relation.kind.trim(),
        target: { ...relation.target },
      })),
      time: {
        occurredAt: input.facets?.time?.occurredAt
          ?? input.sourceRefs.map((source) => source.occurredAt).sort().at(-1)
          ?? null,
        validFrom: input.facets?.time?.validFrom ?? input.validFrom ?? null,
        validUntil: input.facets?.time?.validUntil ?? input.validUntil ?? null,
      },
      sources: [...new Set(input.sourceRefs.map(memoryEvidenceId))],
    },
  };
}

export interface MemoryPage {
  ref: MemoryRef;
  metadata: MemoryPageMetadata;
  body: string;
  digest: string;
}

export interface MemoryAtom {
  layer: 'L1';
  page: MemoryPage & { metadata: LayeredMemoryPageMetadata & { layer: 'L1' } };
}

export interface MemorySceneTopic {
  layer: 'L2';
  page: MemoryPage & { metadata: LayeredMemoryPageMetadata & { layer: 'L2' } };
  derivedFrom: MemoryRef[];
}

export interface MemoryDocument extends MemoryPage {
  path?: string;
  stale?: boolean;
}

export interface MemoryHit {
  ref: MemoryRef;
  title: string;
  summary: string;
  kind: MemoryKind;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  score: number;
  sourceRefs: SourceRef[];
  documentType: 'wiki' | 'source' | 'episode';
  stale?: boolean;
  layer?: MemoryPageLayer;
  facets?: MemoryTypedFacets;
  derivedFrom?: MemoryRef[];
}

export interface MemoryCard extends MemoryHit {}

export interface MemoryLink {
  direction: 'in' | 'out';
  ref: MemoryRef;
  title: string;
}

export interface MemorySearchOptions {
  scope?: MemoryScope | 'all';
  order?: 'relevance' | 'recent';
  kind?: MemoryKind;
  status?: MemoryStatus | 'all';
  relationKinds?: string[];
  stale?: boolean;
  from?: string;
  to?: string;
  includeEvidence?: boolean;
  limit?: number;
  documentTypes?: Array<'wiki' | 'source' | 'episode'>;
}

export interface RememberInput {
  title: string;
  content: string;
  kind: MemoryKind;
  scope?: MemoryScope;
  confidence?: MemoryConfidence;
  aliases?: string[];
  tags?: string[];
  sourceRefs?: SourceRef[];
  sourcePaths?: string[];
  supersedes?: string[];
  links?: string[];
  targetRef?: MemoryRef;
  canonicalKey?: string;
  autonomous?: boolean;
  layer?: MemoryPageLayer;
  facets?: MemoryFacetInput;
  derivedFrom?: MemoryRef[];
}

export interface PersonalContextItem {
  section: 'today-focus' | 'recent-commitments' | 'waiting-on-others' | 'project-risks';
  card: MemoryCard;
  derivedFrom: MemoryRef[];
}

export interface PersonalContext {
  layer: 'L3';
  items: PersonalContextItem[];
  derivedFrom: MemoryRef[];
  estimatedTokens: number;
  status: 'complete' | 'partial' | 'blocked';
  complete: boolean;
}

export interface ForgetReceipt {
  ref: MemoryRef;
  forgotten: boolean;
  suppressedDigest?: string;
  timestamp: string;
}

export interface MemoryStatusSnapshot {
  pages: number;
  privatePages: number;
  workspacePages: number;
  conflicted: number;
  stale: number;
  fts5: boolean;
  degraded: boolean;
  embeddingModel?: string;
  embeddingDimensions?: number;
  retrievalMode?: 'hybrid' | 'lexical-only';
  pendingReceipts?: number;
  decisions?: number;
  pageLimitReached?: boolean;
  episodes?: number;
  candidates?: number;
  revisions?: number;
  pendingCompilations?: number;
  uncertainCompilations?: number;
  vectorAvailable?: boolean;
  vectorVersion?: string;
  vectorState?: 'ready' | 'empty' | 'unavailable' | 'reindex-required' | 'reindexing';
  vectorReason?: string;
  providerConfigured?: boolean;
  vectorRows?: number;
  nextAction?: 'configure-embedding-provider' | 'enable-hybrid' | 'run-reindex'
    | 'wait-for-reindex' | 'repair-vector' | 'use-remote-or-lexical' | 'none';
  embeddingProvider?: 'local' | 'remote';
  embeddingState?: 'ready' | 'missing' | 'corrupt' | 'unsupported' | 'unavailable';
  configuredEmbeddingModel?: string;
  embeddingRevision?: string;
  embeddingModelBytes?: number;
  embeddingRuntime?: string;
}

export interface EpisodeInput {
  sessionId: string;
  runId: string;
  input: string;
  answer: string;
  occurredAt: string;
  sourceRef?: SourceRef;
}

export interface MemoryDecisionEvent {
  id: number;
  operation: string;
  reasonCode: string;
  refId?: string;
  createdAt: string;
}

export interface WikiLintIssue {
  code: string;
  severity: 'error' | 'warning';
  ref?: MemoryRef;
  message: string;
}

export interface WikiLintReport {
  valid: boolean;
  checked: number;
  issues: WikiLintIssue[];
}
