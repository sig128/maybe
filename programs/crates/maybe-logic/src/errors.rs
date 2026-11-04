/// Plan decoding / structural errors. Names match `PlanErrorCode` in plan.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanErr {
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
}

impl PlanErr {
    pub fn code(&self) -> &'static str {
        match self {
            PlanErr::BadMagic => "BAD_MAGIC",
            PlanErr::BadVersion => "BAD_VERSION",
            PlanErr::Truncated => "TRUNCATED",
            PlanErr::TrailingBytes => "TRAILING_BYTES",
            PlanErr::TooLarge => "TOO_LARGE",
            PlanErr::NonCanonical => "NON_CANONICAL",
            PlanErr::CountOutOfRange => "COUNT_OUT_OF_RANGE",
            PlanErr::DuplicateEntry => "DUPLICATE_ENTRY",
            PlanErr::IndexOutOfRange => "INDEX_OUT_OF_RANGE",
            PlanErr::NotTopological => "NOT_TOPOLOGICAL",
            PlanErr::BadNode => "BAD_NODE",
            PlanErr::BadAction => "BAD_ACTION",
            PlanErr::BadAmount => "BAD_AMOUNT",
            PlanErr::FeeTooHigh => "FEE_TOO_HIGH",
            PlanErr::BadSchedule => "BAD_SCHEDULE",
            PlanErr::BadDeadline => "BAD_DEADLINE",
            PlanErr::DepthExceeded => "DEPTH_EXCEEDED",
            PlanErr::BadFlags => "BAD_FLAGS",
        }
    }
}

/// Execution / lifecycle errors. Names match `EngineErrorCode` in engine.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineErr {
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
}

impl EngineErr {
    pub fn code(&self) -> &'static str {
        match self {
            EngineErr::NotActive => "NOT_ACTIVE",
            EngineErr::StrategyPaused => "STRATEGY_PAUSED",
            EngineErr::StrategyClosed => "STRATEGY_CLOSED",
            EngineErr::ExecutionPaused => "EXECUTION_PAUSED",
            EngineErr::PlanHashMismatch => "PLAN_HASH_MISMATCH",
            EngineErr::ActionComplete => "ACTION_COMPLETE",
            EngineErr::DeadlinePassed => "DEADLINE_PASSED",
            EngineErr::BranchLost => "BRANCH_LOST",
            EngineErr::GuardPending => "GUARD_PENDING",
            EngineErr::GuardFalse => "GUARD_FALSE",
            EngineErr::DelayPending => "DELAY_PENDING",
            EngineErr::RunNotDue => "RUN_NOT_DUE",
            EngineErr::RunOutOfOrder => "RUN_OUT_OF_ORDER",
            EngineErr::AmountZero => "AMOUNT_ZERO",
            EngineErr::InsufficientAllocation => "INSUFFICIENT_ALLOCATION",
            EngineErr::RouteFailed => "ROUTE_FAILED",
            EngineErr::RouteDeltaViolation => "ROUTE_DELTA_VIOLATION",
            EngineErr::MinOutNotMet => "MIN_OUT_NOT_MET",
            EngineErr::NotOwner => "NOT_OWNER",
            EngineErr::CancelLocked => "CANCEL_LOCKED",
            EngineErr::NotExpired => "NOT_EXPIRED",
            EngineErr::NotComplete => "NOT_COMPLETE",
            EngineErr::ExpiryInPast => "EXPIRY_IN_PAST",
            EngineErr::DurationTooLong => "DURATION_TOO_LONG",
            EngineErr::FeeAboveCap => "FEE_ABOVE_CAP",
            EngineErr::MintNotAllowed => "MINT_NOT_ALLOWED",
            EngineErr::InsufficientAvailable => "INSUFFICIENT_AVAILABLE",
            EngineErr::BadPlan => "BAD_PLAN",
            EngineErr::Overflow => "OVERFLOW",
        }
    }
}
