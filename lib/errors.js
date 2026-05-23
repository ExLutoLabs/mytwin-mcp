// Errors that are safe to show directly to the user.
// `wrap()` in create-server.js passes UserError.message through unchanged;
// any other thrown error gets mapped to a generic "something went wrong" string.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.userFacing = true;
  }
}
