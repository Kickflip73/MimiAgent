export const TOOL_LEDGER_ARGUMENTS = Symbol('mimi.toolLedgerArguments');

export interface ToolActionIntentMetadata {
  actionFamily: string;
  targetRef: string;
  payload: unknown;
  selectedRoute: string;
  targetEvidenceRef?: string;
  guarded?: {
    exactTarget: boolean;
    lowRisk: boolean;
    reversible: boolean;
  };
  authorizationId?: string;
  authorizationExpiresAt?: string;
  requestedAuthorizationId?: string;
  outcome?: (result: unknown) => 'confirmed' | 'failed_safe' | 'uncertain';
}

export const TOOL_ACTION_INTENT = Symbol('mimi.toolActionIntent');
