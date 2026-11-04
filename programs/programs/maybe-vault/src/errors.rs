use anchor_lang::prelude::*;
use maybe_logic::errors::{EngineErr, PlanErr};
use maybe_logic::policy::PolicyViolation;
use maybe_logic::tokens::TokenErr;

/// Error codes. Order is part of the client contract (SDK maps code → name):
/// 6000.. plan errors, 6018.. engine errors, 6047.. program errors.
#[error_code]
pub enum MaybeError {
    // ---- plan (6000)
    BadMagic,
    BadVersion,
    Truncated,
    TrailingBytes,
    TooLarge,
    NonCanonical,
    CountOutOfRange,
    DuplicateEntry,
    IndexOutOfRange,
    NotTopological,
    BadNode,
    BadAction,
    BadAmount,
    FeeTooHigh,
    BadSchedule,
    BadDeadline,
    DepthExceeded,
    BadFlags,
    // ---- engine (6018)
    NotActive,
    StrategyPaused,
    StrategyClosed,
    ExecutionPaused,
    PlanHashMismatch,
    ActionComplete,
    DeadlinePassed,
    BranchLost,
    GuardPending,
    GuardFalse,
    DelayPending,
    RunNotDue,
    RunOutOfOrder,
    AmountZero,
    InsufficientAllocation,
    RouteFailed,
    RouteDeltaViolation,
    MinOutNotMet,
    NotOwner,
    CancelLocked,
    NotExpired,
    NotComplete,
    ExpiryInPast,
    DurationTooLong,
    FeeAboveCap,
    MintNotAllowed,
    InsufficientAvailable,
    BadPlan,
    Overflow,
    // ---- program (6047)
    UnsupportedTokenExtension,
    AssetNotEnabled,
    RouteNotEnabled,
    RouteAccountMismatch,
    ForeignVaultAccountInRoute,
    AttestationInvalid,
    AttestationReplay,
    AttestationExpired,
    DevAttestorForbidden,
    PolicyViolation,
    PolicyRevoked,
    PlanHashInvalid,
    PlanIncomplete,
    Unauthorized,
    InvalidAccount,
    InvalidEventState,
    TooManyEntries,
    InvalidArgument,
    EventMismatch,
    TokenAccountMismatch,
    MintNotRegistered,
    ThresholdNotMet,
    DepositMismatch,
}

pub fn plan_err(e: PlanErr) -> Error {
    let m = match e {
        PlanErr::BadMagic => MaybeError::BadMagic,
        PlanErr::BadVersion => MaybeError::BadVersion,
        PlanErr::Truncated => MaybeError::Truncated,
        PlanErr::TrailingBytes => MaybeError::TrailingBytes,
        PlanErr::TooLarge => MaybeError::TooLarge,
        PlanErr::NonCanonical => MaybeError::NonCanonical,
        PlanErr::CountOutOfRange => MaybeError::CountOutOfRange,
        PlanErr::DuplicateEntry => MaybeError::DuplicateEntry,
        PlanErr::IndexOutOfRange => MaybeError::IndexOutOfRange,
        PlanErr::NotTopological => MaybeError::NotTopological,
        PlanErr::BadNode => MaybeError::BadNode,
        PlanErr::BadAction => MaybeError::BadAction,
        PlanErr::BadAmount => MaybeError::BadAmount,
        PlanErr::FeeTooHigh => MaybeError::FeeTooHigh,
        PlanErr::BadSchedule => MaybeError::BadSchedule,
        PlanErr::BadDeadline => MaybeError::BadDeadline,
        PlanErr::DepthExceeded => MaybeError::DepthExceeded,
        PlanErr::BadFlags => MaybeError::BadFlags,
    };
    m.into()
}

pub fn eng_err(e: EngineErr) -> Error {
    let m = match e {
        EngineErr::NotActive => MaybeError::NotActive,
        EngineErr::StrategyPaused => MaybeError::StrategyPaused,
        EngineErr::StrategyClosed => MaybeError::StrategyClosed,
        EngineErr::ExecutionPaused => MaybeError::ExecutionPaused,
        EngineErr::PlanHashMismatch => MaybeError::PlanHashMismatch,
        EngineErr::ActionComplete => MaybeError::ActionComplete,
        EngineErr::DeadlinePassed => MaybeError::DeadlinePassed,
        EngineErr::BranchLost => MaybeError::BranchLost,
        EngineErr::GuardPending => MaybeError::GuardPending,
        EngineErr::GuardFalse => MaybeError::GuardFalse,
        EngineErr::DelayPending => MaybeError::DelayPending,
        EngineErr::RunNotDue => MaybeError::RunNotDue,
        EngineErr::RunOutOfOrder => MaybeError::RunOutOfOrder,
        EngineErr::AmountZero => MaybeError::AmountZero,
        EngineErr::InsufficientAllocation => MaybeError::InsufficientAllocation,
        EngineErr::RouteFailed => MaybeError::RouteFailed,
        EngineErr::RouteDeltaViolation => MaybeError::RouteDeltaViolation,
        EngineErr::MinOutNotMet => MaybeError::MinOutNotMet,
        EngineErr::NotOwner => MaybeError::NotOwner,
        EngineErr::CancelLocked => MaybeError::CancelLocked,
        EngineErr::NotExpired => MaybeError::NotExpired,
        EngineErr::NotComplete => MaybeError::NotComplete,
        EngineErr::ExpiryInPast => MaybeError::ExpiryInPast,
        EngineErr::DurationTooLong => MaybeError::DurationTooLong,
        EngineErr::FeeAboveCap => MaybeError::FeeAboveCap,
        EngineErr::MintNotAllowed => MaybeError::MintNotAllowed,
        EngineErr::InsufficientAvailable => MaybeError::InsufficientAvailable,
        EngineErr::BadPlan => MaybeError::BadPlan,
        EngineErr::Overflow => MaybeError::Overflow,
    };
    m.into()
}

pub fn token_err(e: TokenErr) -> Error {
    match e {
        TokenErr::ForbiddenExtension(t) => {
            msg!("forbidden token-2022 extension type {}", t);
            MaybeError::UnsupportedTokenExtension.into()
        }
        TokenErr::MalformedExtensions => MaybeError::UnsupportedTokenExtension.into(),
        _ => MaybeError::InvalidAccount.into(),
    }
}

pub fn policy_err(v: PolicyViolation) -> Error {
    msg!("policy violation: {:?}", v);
    match v {
        PolicyViolation::Revoked | PolicyViolation::StaleEpoch | PolicyViolation::Expired => MaybeError::PolicyRevoked.into(),
        _ => MaybeError::PolicyViolation.into(),
    }
}
