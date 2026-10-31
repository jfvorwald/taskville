/** A storage invariant was violated or the database cannot be used safely. */
export class StorageError extends Error {
  override name = "StorageError";
}
