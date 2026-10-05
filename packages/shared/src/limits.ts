/** Total executions of one step (first try plus retries). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Hard cap. Callers cannot raise the bound and keep improvising.
 * A step is attempted at most this many times, then the plan fails closed.
 */
export const MAX_ATTEMPTS_CAP = 3;

/** Calypso runs workers on this machine. There is no cloud execution mode. */
export const LOCAL_EXECUTION = "local" as const;

export type ExecutionMode = typeof LOCAL_EXECUTION;
