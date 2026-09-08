/**
 * An error we can safely show the user, from any tour source.
 *
 * `code` is a stable identifier the front end and tests can branch on;
 * `message` is user-facing prose. Anything thrown that is NOT a SourceError
 * is treated as a bug and reported generically, so internals never leak.
 */
export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}
