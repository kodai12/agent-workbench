/**
 * Agent Workbench ports, design contract v1.
 * This file defines internal APIs, NOT the external Codex/Herdr wire protocol.
 * Generate external protocol types from the installed binaries.
 */
export type Id = string;
export type Digest = `sha256:${string}`;
export type GitOid = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Actor =
  | { kind: "human"; id: Id; connectionId: Id }
  | { kind: "system"; id: Id }
  | { kind: "worker"; id: Id; attemptId: Id; workerInstanceId: Id };

export interface AwError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, Json>;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: AwError };
export interface ArtifactRef { digest: Digest; mediaType: string; sizeBytes: number }
export interface ModelSelection {
  profileId: string;
  profileDigest: Digest;
  providerId: string;
  trainingFamily: string;
  modelId: string;
  reasoningEffort: string | null;
}
export interface CapabilityReport {
  driver: string;
  version: string;
  schemaDigest: Digest | null;
  freshSession: boolean;
  structuredOutput: boolean;
  interrupt: boolean;
  steer: boolean;
  publicHistory: boolean;
  sandboxedCommands: boolean;
  verifiedIsolation: boolean;
  issues: string[];
}
export interface AgentRequest {
  attemptId: Id;
  workerInstanceId: Id;
  role: "implement" | "review" | "board" | "handoff";
  cwd: string | null;
  model: ModelSelection;
  context: ArtifactRef;
  outputSchema: Json;
  outputTokenLimit: number;
  deadlineAtMs: number;
  isolation: "cooperative-local" | "sandbox-verified";
  permissions: {
    writableRoots: string[];
    readableRoots: string[];
    network: "deny" | "explicit-allowlist";
    allowHosts: string[];
  };
}
export interface SessionHandle {
  attemptId: Id;
  driver: string;
  threadId: string | null;
  turnId: string | null;
  processIdentityDigest: Digest;
}
export interface AgentEvent {
  attemptId: Id;
  workerInstanceId: Id;
  sourceSeq: number;
  occurredAtMs: number;
  type: string;
  data: Record<string, Json>;
}
export interface PublicHistoryPage {
  items: { itemId: string; publicText: string; artifact: ArtifactRef | null }[];
  nextCursor: string | null;
}
export interface AgentDriver {
  probe(signal: AbortSignal): Promise<Result<CapabilityReport>>;
  startFresh(request: AgentRequest, signal: AbortSignal): Promise<Result<SessionHandle>>;
  events(handle: SessionHandle, afterSourceSeq: number, signal: AbortSignal): AsyncIterable<AgentEvent>;
  steer(handle: SessionHandle, expectedTurnId: string, text: string, signal: AbortSignal): Promise<Result<void>>;
  interrupt(handle: SessionHandle, signal: AbortSignal): Promise<Result<void>>;
  readPublicHistory(handle: SessionHandle, cursor: string | null, signal: AbortSignal): Promise<Result<PublicHistoryPage>>;
  close(handle: SessionHandle, signal: AbortSignal): Promise<Result<void>>;
}
export interface PresentationHandle {
  variant: "herdr-tui" | "none";
  workspaceId: string | null;
  paneId: string | null;
  agentName: string | null;
  revision: number | null;
}
export interface ManagedPresentationRequest {
  cwd: string;
  label: string;
  workerExecutable: string;
  ticketPath: string; // host-generated path; never arbitrary model command
}
export interface NativePresentationRequest {
  cwd: string;
  label: string;
  model: ModelSelection;
  codexHome: string;
  initialPrompt: ArtifactRef;
}
export interface PresentationDriver {
  probe(signal: AbortSignal): Promise<Result<CapabilityReport>>;
  startManaged(request: ManagedPresentationRequest, signal: AbortSignal): Promise<Result<PresentationHandle>>;
  startNative(request: NativePresentationRequest, signal: AbortSignal): Promise<Result<PresentationHandle>>;
  attach(handle: PresentationHandle, signal: AbortSignal): Promise<Result<void>>;
  getStatus(handle: PresentationHandle, signal: AbortSignal): Promise<Result<Record<string, Json>>>;
  closePresentation(handle: PresentationHandle, signal: AbortSignal): Promise<Result<void>>;
}
export interface CheckRequest {
  attemptId: Id;
  candidateIdentityDigest: Digest;
  checkId: string;
  cwd: string;
  argv: string[];
  environment: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  expectedArtifactPaths: string[];
  network: "deny" | "explicit-allowlist";
  allowHosts: string[];
}
export interface CheckResult {
  attemptId: Id;
  candidateIdentityDigest: Digest;
  checkId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  sourceUnchanged: boolean;
  isolationVerified: boolean;
  simulated: boolean;
  output: ArtifactRef;
  outputs: ArtifactRef[];
}
export interface CheckRunner {
  execute(request: CheckRequest, signal: AbortSignal): Promise<Result<CheckResult>>;
}
export interface WorkspaceRecord {
  id: Id;
  taskId: Id;
  path: string;
  branchRef: string | null;
  baseSha: GitOid;
  role: "writer" | "check" | "review" | "board" | "experiment";
}
export interface CandidateRecord {
  id: Id;
  taskId: Id;
  generation: number;
  identity: Json;
  identityDigest: Digest;
  integrationBaseSha: GitOid;
  candidateSha: GitOid;
  candidateTreeSha: GitOid;
}
export interface GateDecision {
  passed: boolean;
  candidateIdentityDigest: Digest;
  evidenceDigest: Digest;
  blockingReasons: { code: string; reference: string | null; message: string }[];
}
export interface ApprovalBinding {
  schemaVersion: 1;
  action: "integrate" | "publish" | "risk_accept";
  repoId: Id;
  taskId: Id;
  candidateIdentityDigest: Digest;
  evidenceDigest: Digest;
  targetRef: string;
  expectedBaseSha: GitOid;
  expiresAtMs: number;
  nonce: string;
}
export interface IntegrationRecord {
  id: Id;
  commandId: Id;
  targetRef: string;
  expectedOldSha: GitOid;
  newSha: GitOid;
  state: "prepared" | "applied" | "failed" | "uncertain";
}
export interface StateStore {
  transact<T>(fn: () => T): T; // synchronous, no await or I/O inside
  appendEvent(aggregateId: Id, expectedVersion: number, type: string, payload: Json, actor: Actor): Result<number>;
  loadCandidate(id: Id): Result<CandidateRecord>;
  reserveWorkspace(record: WorkspaceRecord): Result<void>;
  prepareIntegration(record: IntegrationRecord): Result<void>;
}
export interface ArtifactStore {
  put(bytes: Uint8Array, mediaType: string, maximumBytes: number): Promise<Result<ArtifactRef>>;
  readVerified(digest: Digest): Promise<Result<Uint8Array>>;
}
export interface GitPort {
  createWorkspace(record: WorkspaceRecord): Promise<Result<void>>;
  freezeSnapshot(workspace: WorkspaceRecord, expectedBase: GitOid): Promise<Result<{ commit: GitOid; tree: GitOid }>>;
  compareAndSwapRef(targetRef: string, oldSha: GitOid, newSha: GitOid): Promise<Result<void>>;
  readRef(targetRef: string): Promise<Result<GitOid>>;
}
