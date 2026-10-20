export type GitOperationErrorCode = 'unavailable' | 'unsafe' | 'unsupported' | 'stale' | 'busy' | 'invalid' | 'failed' | 'unknown';

export class GitOperationError extends Error {
  constructor(readonly code: GitOperationErrorCode, message = `Git operation ${code}.`, readonly processExitUnverified = false) {
    super(message);
    this.name = 'GitOperationError';
  }
}
