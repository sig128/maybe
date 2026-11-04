//! Pure MAYBE plan semantics, shared by the `maybe_vault` program and tested on
//! the host against the TypeScript engine's conformance fixtures
//! (`packages/core/conformance`). No Solana dependencies: everything here is
//! plain integer logic over byte slices so it can be audited and fuzzed in
//! isolation, and so that the program handlers stay thin.
//!
//! Mirrors (keep in sync):
//!   plan.rs      <-> packages/core/src/plan.ts
//!   predicate.rs <-> packages/core/src/predicate.ts
//!   engine.rs    <-> packages/core/src/engine.ts (readiness / execute / close)
//!   policy.rs    <-> packages/core/src/policy.ts
//!   tokens.rs    <-> packages/core/src/assets.ts (token-extension allowlist)

pub mod attest;
pub mod engine;
pub mod errors;
pub mod plan;
pub mod policy;
pub mod predicate;
pub mod tokens;

pub use errors::{EngineErr, PlanErr};
