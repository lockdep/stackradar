import type { Cluster } from '@/types/cluster';

/**
 * The NewClusterDialog wizard as an explicit state machine.
 *
 * Each step carries only the data that can exist at that step — there is no
 * reachable "on the API-key step without a cluster" or "creating while a key
 * is showing" state, which the previous boolean-flag version had to rule out
 * by convention.
 */
export type WizardStep = 'details' | 'apiKey' | 'install';

export type WizardState =
    | {
          step: 'details';
          name: string;
          nameTouched: boolean;
          description: string;
          isCreating: boolean;
          error: string | null;
          isPlanLimitError: boolean;
      }
    | {
          step: 'apiKey';
          cluster: Cluster;
          apiKey: string;
          copied: boolean;
          /** The "have you saved your key?" footer nudge, shown when continuing without copying. */
          showCopyConfirm: boolean;
      }
    | {
          step: 'install';
          cluster: Cluster;
          apiKey: string;
          copied: boolean;
      };

export type WizardAction =
    | { type: 'SET_NAME'; name: string }
    | { type: 'NAME_TOUCHED' }
    | { type: 'CREATE_START' }
    | { type: 'CREATE_SUCCESS'; cluster: Cluster; apiKey: string }
    | { type: 'CREATE_FAILURE'; message: string; isPlanLimit: boolean }
    | { type: 'KEY_COPIED' }
    | { type: 'COPY_INDICATOR_EXPIRED' }
    | { type: 'CONTINUE' }
    | { type: 'CONFIRM_CONTINUE' }
    | { type: 'BACK' }
    | { type: 'RESET' };

export const initialWizardState: WizardState = {
    step: 'details',
    name: '',
    nameTouched: false,
    description: '',
    isCreating: false,
    error: null,
    isPlanLimitError: false,
};

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
    switch (action.type) {
        case 'SET_NAME':
            // Typing clears the error text but deliberately not the plan-limit
            // panel — matching the pre-reducer behavior.
            if (state.step !== 'details') return state;
            return { ...state, name: action.name, error: null };
        case 'NAME_TOUCHED':
            if (state.step !== 'details') return state;
            return { ...state, nameTouched: true };
        case 'CREATE_START':
            if (state.step !== 'details') return state;
            return { ...state, isCreating: true, error: null };
        case 'CREATE_SUCCESS':
            if (state.step !== 'details') return state;
            return {
                step: 'apiKey',
                cluster: action.cluster,
                apiKey: action.apiKey,
                copied: false,
                showCopyConfirm: false,
            };
        case 'CREATE_FAILURE':
            if (state.step !== 'details') return state;
            return { ...state, isCreating: false, error: action.message, isPlanLimitError: action.isPlanLimit };
        case 'KEY_COPIED':
            if (state.step !== 'apiKey') return state;
            return { ...state, copied: true, showCopyConfirm: false };
        case 'COPY_INDICATOR_EXPIRED':
            // The 2s "copied" indicator can expire after the user has moved on
            // to the install step (or after a reset, where it's a no-op).
            if (state.step === 'details') return state;
            return { ...state, copied: false };
        case 'CONTINUE':
            if (state.step !== 'apiKey') return state;
            if (!state.copied) return { ...state, showCopyConfirm: true };
            return { step: 'install', cluster: state.cluster, apiKey: state.apiKey, copied: state.copied };
        case 'CONFIRM_CONTINUE':
            if (state.step !== 'apiKey') return state;
            return { step: 'install', cluster: state.cluster, apiKey: state.apiKey, copied: state.copied };
        case 'BACK':
            if (state.step !== 'install') return state;
            return {
                step: 'apiKey',
                cluster: state.cluster,
                apiKey: state.apiKey,
                copied: state.copied,
                showCopyConfirm: false,
            };
        case 'RESET':
            return initialWizardState;
    }
}

/**
 * A cluster name is a label for people, not an identifier for machines, so
 * the rule is "no special characters and a sensible length" rather than a
 * DNS label. Mirrors `server/src/schemas/cluster.schema.ts` — keep in step.
 */
export const CLUSTER_NAME_MIN_LENGTH = 2;
export const CLUSTER_NAME_MAX_LENGTH = 63;
const CLUSTER_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

export const CLUSTER_NAME_HINT = `Letters, numbers, spaces, hyphens, underscores and periods. Between ${CLUSTER_NAME_MIN_LENGTH} and ${CLUSTER_NAME_MAX_LENGTH} characters.`;

/** Validates the name as it will be sent — trimmed. Returns a message or null. */
export function validateClusterName(value: string): string | null {
    const name = value.trim();
    if (!name) return 'Name is required';
    if (name.length < CLUSTER_NAME_MIN_LENGTH) return `Name must be at least ${CLUSTER_NAME_MIN_LENGTH} characters`;
    if (name.length > CLUSTER_NAME_MAX_LENGTH) return `Name must be ${CLUSTER_NAME_MAX_LENGTH} characters or fewer`;
    if (!CLUSTER_NAME_RE.test(name))
        return 'Only letters, numbers, spaces, hyphens, underscores and periods — must start with a letter or number';
    return null;
}

export const WIZARD_STEPS: { id: WizardStep; label: string }[] = [
    { id: 'details', label: 'Details' },
    { id: 'apiKey', label: 'API key' },
    { id: 'install', label: 'Install' },
];
