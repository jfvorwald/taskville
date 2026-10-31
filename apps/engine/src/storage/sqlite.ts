// The ARCHITECTURE.md and spec 001 name `Database` and `Statement` from
// `node:sqlite`, but Node 26.8.2 (the pinned minimum) exports only
// `DatabaseSync` and `StatementSync`. Every storage module imports the classes
// from here, so switching to the new names when Node ships them is a one-line
// change.
export { DatabaseSync as Database, StatementSync as Statement } from "node:sqlite";
