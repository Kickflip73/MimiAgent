export const TOOL_LEDGER_ARGUMENTS = Symbol('mimi.toolLedgerArguments');

export interface ToolActionIntentMetadata {
  actionFamily: string;
  targetRef: string;
  businessActionRef?: string;
  payload: unknown;
  selectedRoute: string;
  effect?: 'read' | 'write' | 'unknown';
  targetEvidenceRef?: string;
  guarded?: {
    exactTarget: boolean;
    lowRisk: boolean;
    reversible: boolean;
    boundedLocal?: boolean;
  };
  authorizationId?: string;
  authorizationExpiresAt?: string;
  requestedAuthorizationId?: string;
  outcome?: (result: unknown) => 'confirmed' | 'failed_safe' | 'uncertain';
}

export const TOOL_ACTION_INTENT = Symbol('mimi.toolActionIntent');
