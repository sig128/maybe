//! `MYB1` plan format — strict, canonical decoding over a borrowed byte slice.
//! Mirrors packages/core/src/plan.ts (`decodePlan` + `checkPlanStructure`),
//! including the ORDER in which errors are detected, so both sides report the
//! same first error for the same malformed input.

use crate::errors::PlanErr;

pub const MAGIC: [u8; 4] = *b"MYB1";
pub const VERSION: u8 = 1;
pub const HEADER_SIZE: usize = 32;
pub const ALLOC_SIZE: usize = 16;
pub const NODE_SIZE: usize = 24;
pub const ACTION_SIZE: usize = 72;

pub const MAX_EVENTS: usize = 8;
pub const MAX_MINTS: usize = 6;
pub const MAX_REFS: usize = 6;
pub const MAX_ALLOCATIONS: usize = 4;
pub const MAX_NODES: usize = 24;
pub const MAX_ACTIONS: usize = 12;
pub const MAX_CHILDREN: usize = 8;
pub const MAX_GROUPS: usize = 8;
pub const MAX_BRANCHES_PER_GROUP: usize = 8;
pub const MAX_RUNS: u16 = 52;
pub const MAX_DEPTH: u32 = 8;
pub const MAX_PLAN_BYTES: usize = 2_600;
pub const MAX_FEE_BPS: u16 = 100;
pub const MIN_SCHEDULE_INTERVAL_SECONDS: u32 = 60;
pub const MAX_DELAY_SECONDS: u32 = 365 * 24 * 3600;
pub const MAX_STRATEGY_DURATION_SECONDS: i64 = 400 * 24 * 3600;
pub const MAX_VETO_WINDOW_SECONDS: i64 = 30 * 24 * 3600;

pub const NONE: u8 = 0xff;

pub const PLAN_FLAG_CANCEL_LOCKED: u8 = 0b0000_0001;
pub const ACTION_FLAG_MIN_OUT_IS_RATE: u8 = 0b0000_0001;
pub const ACTION_FLAG_MISSED_CATCH_UP: u8 = 0b0000_0010;

pub const OP_ALWAYS: u8 = 0;
pub const OP_OUTCOME: u8 = 1;
pub const OP_NOT: u8 = 2;
pub const OP_AND: u8 = 3;
pub const OP_OR: u8 = 4;
pub const OP_ATLEAST: u8 = 5;
pub const OP_VETO: u8 = 6;
pub const OP_RECEIPT: u8 = 7;
pub const OP_AFTER: u8 = 8;

pub const KIND_SWAP: u8 = 1;
pub const KIND_TRANSFER: u8 = 2;
pub const KIND_RELEASE: u8 = 3;

pub const ROUTE_NONE: u8 = 0;
pub const ROUTE_CP_SWAP: u8 = 1;
pub const ROUTE_OUTCOME_BUY: u8 = 2;
pub const ROUTE_OUTCOME_REDEEM: u8 = 3;

pub const AMOUNT_FIXED: u8 = 1;
pub const AMOUNT_BPS_OF_ALLOCATION: u8 = 2;
pub const AMOUNT_BPS_OF_RECEIVED: u8 = 3;
pub const AMOUNT_ALL_OF_HOLDING: u8 = 4;

pub const OUTCOME_NO: u8 = 0;
pub const OUTCOME_YES: u8 = 1;
pub const OUTCOME_VOID: u8 = 2;

/// JS `Number.MAX_SAFE_INTEGER`; the TS decoder rejects i64 fields outside ±this.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub version: u8,
    pub flags: u8,
    pub n_events: u8,
    pub n_mints: u8,
    pub n_refs: u8,
    pub n_allocs: u8,
    pub n_nodes: u8,
    pub n_actions: u8,
    pub max_fee_bps: u16,
    pub void_policy: u8,
    pub expires_at: i64,
    pub nonce: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Alloc {
    pub mint: u8,
    pub amount: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Node {
    pub op: u8,
    pub a: u8,
    pub b: u8,
    pub k: u8,
    pub n: u8,
    pub children: [u8; MAX_CHILDREN],
    pub param: i64,
}

impl Node {
    pub fn child(&self, i: usize) -> u8 {
        self.children[i]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionDef {
    pub kind: u8,
    pub guard: u8,
    pub alloc: u8,
    pub in_mint: u8,
    pub out_mint: u8,
    pub route_kind: u8,
    pub r#ref: u8,
    pub group: u8,
    pub branch: u8,
    pub amount_kind: u8,
    pub amount_ref: u8,
    pub flags: u8,
    pub bps: u16,
    pub fee_bps: u16,
    pub runs: u16,
    pub delay: u32,
    pub interval: u32,
    pub amount: u64,
    pub min_out: u64,
    pub deadline: i64,
}

impl ActionDef {
    pub fn min_out_is_rate(&self) -> bool {
        self.flags & ACTION_FLAG_MIN_OUT_IS_RATE != 0
    }
    pub fn catch_up(&self) -> bool {
        self.flags & ACTION_FLAG_MISSED_CATCH_UP != 0
    }
}

fn rd_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn rd_u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn rd_u64(b: &[u8], o: usize) -> u64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(x)
}
fn rd_i64(b: &[u8], o: usize) -> i64 {
    rd_u64(b, o) as i64
}
fn safe(v: i64) -> Result<i64, PlanErr> {
    if v > MAX_SAFE || v < -MAX_SAFE {
        Err(PlanErr::BadDeadline)
    } else {
        Ok(v)
    }
}
fn require_zero(b: &[u8], start: usize, len: usize) -> Result<(), PlanErr> {
    if b[start..start + len].iter().any(|x| *x != 0) {
        Err(PlanErr::NonCanonical)
    } else {
        Ok(())
    }
}

pub fn plan_size(n_events: usize, n_mints: usize, n_refs: usize, n_allocs: usize, n_nodes: usize, n_actions: usize) -> usize {
    HEADER_SIZE + 32 * (n_events + n_mints + n_refs) + ALLOC_SIZE * n_allocs + NODE_SIZE * n_nodes + ACTION_SIZE * n_actions
}

/// A validated plan borrowed from account data. Construct only via `parse`.
#[derive(Clone, Copy)]
pub struct PlanView<'a> {
    bytes: &'a [u8],
    pub hdr: Header,
    off_events: usize,
    off_mints: usize,
    off_refs: usize,
    off_allocs: usize,
    off_nodes: usize,
    off_actions: usize,
}

impl<'a> PlanView<'a> {
    /// Strict decode + full structural check (time-independent).
    pub fn parse(bytes: &'a [u8]) -> Result<Self, PlanErr> {
        let v = Self::decode(bytes)?;
        v.check_structure()?;
        Ok(v)
    }

    fn decode(b: &'a [u8]) -> Result<Self, PlanErr> {
        if b.len() > MAX_PLAN_BYTES {
            return Err(PlanErr::TooLarge);
        }
        if b.len() < HEADER_SIZE {
            return Err(PlanErr::Truncated);
        }
        if b[0..4] != MAGIC {
            return Err(PlanErr::BadMagic);
        }
        if b[4] != VERSION {
            return Err(PlanErr::BadVersion);
        }
        require_zero(b, 15, 1)?;
        let expires_at = safe(rd_i64(b, 16))?;
        let hdr = Header {
            version: b[4],
            flags: b[5],
            n_events: b[6],
            n_mints: b[7],
            n_refs: b[8],
            n_allocs: b[9],
            n_nodes: b[10],
            n_actions: b[11],
            max_fee_bps: rd_u16(b, 12),
            void_policy: b[14],
            expires_at,
            nonce: rd_u64(b, 24),
        };
        let expected = plan_size(
            hdr.n_events as usize,
            hdr.n_mints as usize,
            hdr.n_refs as usize,
            hdr.n_allocs as usize,
            hdr.n_nodes as usize,
            hdr.n_actions as usize,
        );
        if b.len() < expected {
            return Err(PlanErr::Truncated);
        }
        if b.len() > expected {
            return Err(PlanErr::TrailingBytes);
        }
        let off_events = HEADER_SIZE;
        let off_mints = off_events + 32 * hdr.n_events as usize;
        let off_refs = off_mints + 32 * hdr.n_mints as usize;
        let off_allocs = off_refs + 32 * hdr.n_refs as usize;
        let off_nodes = off_allocs + ALLOC_SIZE * hdr.n_allocs as usize;
        let off_actions = off_nodes + NODE_SIZE * hdr.n_nodes as usize;
        // canonical-form checks in the same order as the TS decoder
        for i in 0..hdr.n_allocs as usize {
            require_zero(b, off_allocs + i * ALLOC_SIZE + 1, 7)?;
        }
        for i in 0..hdr.n_nodes as usize {
            let o = off_nodes + i * NODE_SIZE;
            require_zero(b, o + 5, 3)?;
            let n = b[o + 4] as usize;
            if n > MAX_CHILDREN {
                return Err(PlanErr::BadNode);
            }
            for c in n..MAX_CHILDREN {
                if b[o + 8 + c] != NONE {
                    return Err(PlanErr::NonCanonical);
                }
            }
            safe(rd_i64(b, o + 16))?;
        }
        for i in 0..hdr.n_actions as usize {
            let o = off_actions + i * ACTION_SIZE;
            require_zero(b, o + 18, 2)?;
            require_zero(b, o + 28, 4)?;
            require_zero(b, o + 56, 16)?;
            safe(rd_i64(b, o + 48))?;
        }
        Ok(PlanView { bytes: b, hdr, off_events, off_mints, off_refs, off_allocs, off_nodes, off_actions })
    }

    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }
    pub fn n_events(&self) -> usize {
        self.hdr.n_events as usize
    }
    pub fn n_mints(&self) -> usize {
        self.hdr.n_mints as usize
    }
    pub fn n_refs(&self) -> usize {
        self.hdr.n_refs as usize
    }
    pub fn n_allocs(&self) -> usize {
        self.hdr.n_allocs as usize
    }
    pub fn n_nodes(&self) -> usize {
        self.hdr.n_nodes as usize
    }
    pub fn n_actions(&self) -> usize {
        self.hdr.n_actions as usize
    }
    fn addr(&self, base: usize, i: usize) -> [u8; 32] {
        let mut a = [0u8; 32];
        a.copy_from_slice(&self.bytes[base + 32 * i..base + 32 * i + 32]);
        a
    }
    pub fn event(&self, i: usize) -> [u8; 32] {
        self.addr(self.off_events, i)
    }
    pub fn mint(&self, i: usize) -> [u8; 32] {
        self.addr(self.off_mints, i)
    }
    pub fn r#ref(&self, i: usize) -> [u8; 32] {
        self.addr(self.off_refs, i)
    }
    pub fn alloc(&self, i: usize) -> Alloc {
        let o = self.off_allocs + i * ALLOC_SIZE;
        Alloc { mint: self.bytes[o], amount: rd_u64(self.bytes, o + 8) }
    }
    pub fn node(&self, i: usize) -> Node {
        let b = self.bytes;
        let o = self.off_nodes + i * NODE_SIZE;
        let mut children = [NONE; MAX_CHILDREN];
        children.copy_from_slice(&b[o + 8..o + 16]);
        Node { op: b[o], a: b[o + 1], b: b[o + 2], k: b[o + 3], n: b[o + 4], children, param: rd_i64(b, o + 16) }
    }
    pub fn action(&self, i: usize) -> ActionDef {
        let b = self.bytes;
        let o = self.off_actions + i * ACTION_SIZE;
        ActionDef {
            kind: b[o],
            guard: b[o + 1],
            alloc: b[o + 2],
            in_mint: b[o + 3],
            out_mint: b[o + 4],
            route_kind: b[o + 5],
            r#ref: b[o + 6],
            group: b[o + 7],
            branch: b[o + 8],
            amount_kind: b[o + 9],
            amount_ref: b[o + 10],
            flags: b[o + 11],
            bps: rd_u16(b, o + 12),
            fee_bps: rd_u16(b, o + 14),
            runs: rd_u16(b, o + 16),
            delay: rd_u32(b, o + 20),
            interval: rd_u32(b, o + 24),
            amount: rd_u64(b, o + 32),
            min_out: rd_u64(b, o + 40),
            deadline: rd_i64(b, o + 48),
        }
    }

    /// Effective deadline: the action's own deadline or the strategy expiry.
    pub fn action_deadline(&self, a: &ActionDef) -> i64 {
        if a.deadline == 0 {
            self.hdr.expires_at
        } else {
            a.deadline.min(self.hdr.expires_at)
        }
    }

    /// Port of `checkPlanStructure` — returns the FIRST issue in the TS order.
    pub fn check_structure(&self) -> Result<(), PlanErr> {
        let h = &self.hdr;
        if h.version != VERSION {
            return Err(PlanErr::BadVersion);
        }
        if h.flags & !PLAN_FLAG_CANCEL_LOCKED != 0 {
            return Err(PlanErr::BadFlags);
        }
        if h.void_policy != 0 {
            return Err(PlanErr::BadFlags);
        }
        if h.max_fee_bps > MAX_FEE_BPS {
            return Err(PlanErr::FeeTooHigh);
        }
        if h.expires_at <= 0 {
            return Err(PlanErr::BadDeadline);
        }
        let range = |n: usize, lo: usize, hi: usize| if n < lo || n > hi { Err(PlanErr::CountOutOfRange) } else { Ok(()) };
        range(self.n_events(), 0, MAX_EVENTS)?;
        range(self.n_mints(), 1, MAX_MINTS)?;
        range(self.n_refs(), 0, MAX_REFS)?;
        range(self.n_allocs(), 1, MAX_ALLOCATIONS)?;
        range(self.n_nodes(), 1, MAX_NODES)?;
        range(self.n_actions(), 1, MAX_ACTIONS)?;
        for (base, n) in [(self.off_events, self.n_events()), (self.off_mints, self.n_mints()), (self.off_refs, self.n_refs())] {
            for i in 0..n {
                for j in 0..i {
                    if self.addr(base, i) == self.addr(base, j) {
                        return Err(PlanErr::DuplicateEntry);
                    }
                }
            }
        }
        for i in 0..self.n_allocs() {
            let a = self.alloc(i);
            if a.mint as usize >= self.n_mints() {
                return Err(PlanErr::IndexOutOfRange);
            }
            if a.amount == 0 {
                return Err(PlanErr::BadAmount);
            }
        }
        let mut depth = [0u32; MAX_NODES];
        for i in 0..self.n_nodes() {
            let n = self.node(i);
            let mut d: u32 = 1;
            for c in 0..n.n as usize {
                let ch = n.children[c] as usize;
                if ch >= i {
                    return Err(PlanErr::NotTopological);
                }
                d = d.max(depth[ch].max(1) + 1);
            }
            depth[i] = d;
            if d > MAX_DEPTH {
                return Err(PlanErr::DepthExceeded);
            }
            let shape = |ok: bool| if ok { Ok(()) } else { Err(PlanErr::BadNode) };
            let n_events = self.n_events() as u8;
            match n.op {
                OP_ALWAYS => shape(n.a == 0 && n.b == 0 && n.k == 0 && n.n == 0 && n.param == 0)?,
                OP_OUTCOME => {
                    shape(n.a < n_events)?;
                    shape(n.b == OUTCOME_YES || n.b == OUTCOME_NO)?;
                    shape(n.k == 0 && n.n == 0 && n.param == 0)?;
                }
                OP_NOT => shape(n.n == 1 && n.a == 0 && n.b == 0 && n.k == 0 && n.param == 0)?,
                OP_AND | OP_OR => shape(n.n >= 2 && n.a == 0 && n.b == 0 && n.k == 0 && n.param == 0)?,
                OP_ATLEAST => shape(n.n >= 2 && n.k >= 1 && n.k <= n.n && n.a == 0 && n.b == 0 && n.param == 0)?,
                OP_VETO => {
                    shape(n.a < n_events)?;
                    shape(n.b == OUTCOME_YES || n.b == OUTCOME_NO)?;
                    shape(n.n == 1 && n.k == 0)?;
                    shape(n.param >= 0 && n.param <= MAX_VETO_WINDOW_SECONDS)?;
                }
                OP_RECEIPT => {
                    shape(n.a == NONE || (n.a as usize) < self.n_refs())?;
                    shape(n.a != NONE || (n.b as usize) < self.n_actions())?;
                    shape(n.k == 0 && n.n == 0 && n.param == 0)?;
                }
                OP_AFTER => shape(n.a == 0 && n.b == 0 && n.k == 0 && n.n == 0 && n.param > 0)?,
                _ => return Err(PlanErr::BadNode),
            }
        }
        for i in 0..self.n_actions() {
            let a = self.action(i);
            if a.guard as usize >= self.n_nodes() {
                return Err(PlanErr::IndexOutOfRange);
            }
            if a.alloc as usize >= self.n_allocs() {
                return Err(PlanErr::IndexOutOfRange);
            }
            if a.in_mint as usize >= self.n_mints() {
                return Err(PlanErr::IndexOutOfRange);
            }
            if a.flags & !(ACTION_FLAG_MIN_OUT_IS_RATE | ACTION_FLAG_MISSED_CATCH_UP) != 0 {
                return Err(PlanErr::BadFlags);
            }
            if a.fee_bps > h.max_fee_bps {
                return Err(PlanErr::FeeTooHigh);
            }
            match a.kind {
                KIND_SWAP => {
                    if a.out_mint as usize >= self.n_mints() {
                        return Err(PlanErr::IndexOutOfRange);
                    } else if a.out_mint == a.in_mint {
                        return Err(PlanErr::BadAction);
                    }
                    if a.route_kind < ROUTE_CP_SWAP || a.route_kind > ROUTE_OUTCOME_REDEEM {
                        return Err(PlanErr::BadAction);
                    }
                    if a.r#ref as usize >= self.n_refs() {
                        return Err(PlanErr::IndexOutOfRange);
                    }
                    if a.min_out == 0 {
                        return Err(PlanErr::BadAmount);
                    }
                }
                KIND_TRANSFER => {
                    if a.out_mint != NONE || a.route_kind != ROUTE_NONE {
                        return Err(PlanErr::BadAction);
                    }
                    if a.r#ref as usize >= self.n_refs() {
                        return Err(PlanErr::IndexOutOfRange);
                    }
                    if a.min_out != 0 || a.min_out_is_rate() {
                        return Err(PlanErr::BadAction);
                    }
                }
                KIND_RELEASE => {
                    if a.out_mint != NONE || a.route_kind != ROUTE_NONE || a.r#ref != NONE {
                        return Err(PlanErr::BadAction);
                    }
                    if a.fee_bps != 0 {
                        return Err(PlanErr::BadAction);
                    }
                    if a.min_out != 0 || a.min_out_is_rate() {
                        return Err(PlanErr::BadAction);
                    }
                }
                _ => return Err(PlanErr::BadAction),
            }
            if a.group != NONE {
                if a.group as usize >= MAX_GROUPS || a.branch as usize >= MAX_BRANCHES_PER_GROUP {
                    return Err(PlanErr::BadAction);
                }
            } else if a.branch != 0 {
                return Err(PlanErr::NonCanonical);
            }
            match a.amount_kind {
                AMOUNT_FIXED => {
                    if a.amount == 0 {
                        return Err(PlanErr::BadAmount);
                    }
                    if a.bps != 0 || a.amount_ref != NONE {
                        return Err(PlanErr::NonCanonical);
                    }
                }
                AMOUNT_BPS_OF_ALLOCATION => {
                    if a.bps < 1 || a.bps > 10_000 {
                        return Err(PlanErr::BadAmount);
                    }
                    if a.amount != 0 || a.amount_ref != NONE {
                        return Err(PlanErr::NonCanonical);
                    }
                }
                AMOUNT_BPS_OF_RECEIVED => {
                    if a.bps < 1 || a.bps > 10_000 {
                        return Err(PlanErr::BadAmount);
                    }
                    if a.amount_ref as usize >= self.n_actions() || a.amount_ref as usize == i {
                        return Err(PlanErr::IndexOutOfRange);
                    }
                    let src = self.action(a.amount_ref as usize);
                    if src.kind != KIND_SWAP {
                        return Err(PlanErr::BadAmount);
                    } else if src.out_mint != a.in_mint {
                        return Err(PlanErr::BadAmount);
                    }
                }
                AMOUNT_ALL_OF_HOLDING => {
                    if a.bps != 0 || a.amount_ref != NONE {
                        return Err(PlanErr::NonCanonical);
                    }
                }
                _ => return Err(PlanErr::BadAmount),
            }
            if a.runs < 1 || a.runs > MAX_RUNS {
                return Err(PlanErr::BadSchedule);
            }
            if a.runs == 1 {
                if a.interval != 0 || a.catch_up() {
                    return Err(PlanErr::NonCanonical);
                }
            } else if a.interval < MIN_SCHEDULE_INTERVAL_SECONDS {
                return Err(PlanErr::BadSchedule);
            }
            if a.delay > MAX_DELAY_SECONDS {
                return Err(PlanErr::BadSchedule);
            }
            if a.deadline < 0 || (a.deadline != 0 && a.deadline > h.expires_at) {
                return Err(PlanErr::BadDeadline);
            }
        }
        Ok(())
    }

    /// Re-encode every field from the parsed view (host round-trip tests).
    pub fn reencode(&self) -> Vec<u8> {
        let mut out = vec![0u8; self.bytes.len()];
        out[0..4].copy_from_slice(&MAGIC);
        out[4] = self.hdr.version;
        out[5] = self.hdr.flags;
        out[6] = self.hdr.n_events;
        out[7] = self.hdr.n_mints;
        out[8] = self.hdr.n_refs;
        out[9] = self.hdr.n_allocs;
        out[10] = self.hdr.n_nodes;
        out[11] = self.hdr.n_actions;
        out[12..14].copy_from_slice(&self.hdr.max_fee_bps.to_le_bytes());
        out[14] = self.hdr.void_policy;
        out[16..24].copy_from_slice(&self.hdr.expires_at.to_le_bytes());
        out[24..32].copy_from_slice(&self.hdr.nonce.to_le_bytes());
        for i in 0..self.n_events() {
            out[self.off_events + 32 * i..self.off_events + 32 * i + 32].copy_from_slice(&self.event(i));
        }
        for i in 0..self.n_mints() {
            out[self.off_mints + 32 * i..self.off_mints + 32 * i + 32].copy_from_slice(&self.mint(i));
        }
        for i in 0..self.n_refs() {
            out[self.off_refs + 32 * i..self.off_refs + 32 * i + 32].copy_from_slice(&self.r#ref(i));
        }
        for i in 0..self.n_allocs() {
            let a = self.alloc(i);
            let o = self.off_allocs + i * ALLOC_SIZE;
            out[o] = a.mint;
            out[o + 8..o + 16].copy_from_slice(&a.amount.to_le_bytes());
        }
        for i in 0..self.n_nodes() {
            let n = self.node(i);
            let o = self.off_nodes + i * NODE_SIZE;
            out[o] = n.op;
            out[o + 1] = n.a;
            out[o + 2] = n.b;
            out[o + 3] = n.k;
            out[o + 4] = n.n;
            for c in 0..MAX_CHILDREN {
                out[o + 8 + c] = if c < n.n as usize { n.children[c] } else { NONE };
            }
            out[o + 16..o + 24].copy_from_slice(&n.param.to_le_bytes());
        }
        for i in 0..self.n_actions() {
            let a = self.action(i);
            let o = self.off_actions + i * ACTION_SIZE;
            out[o] = a.kind;
            out[o + 1] = a.guard;
            out[o + 2] = a.alloc;
            out[o + 3] = a.in_mint;
            out[o + 4] = a.out_mint;
            out[o + 5] = a.route_kind;
            out[o + 6] = a.r#ref;
            out[o + 7] = a.group;
            out[o + 8] = a.branch;
            out[o + 9] = a.amount_kind;
            out[o + 10] = a.amount_ref;
            out[o + 11] = a.flags;
            out[o + 12..o + 14].copy_from_slice(&a.bps.to_le_bytes());
            out[o + 14..o + 16].copy_from_slice(&a.fee_bps.to_le_bytes());
            out[o + 16..o + 18].copy_from_slice(&a.runs.to_le_bytes());
            out[o + 20..o + 24].copy_from_slice(&a.delay.to_le_bytes());
            out[o + 24..o + 28].copy_from_slice(&a.interval.to_le_bytes());
            out[o + 32..o + 40].copy_from_slice(&a.amount.to_le_bytes());
            out[o + 40..o + 48].copy_from_slice(&a.min_out.to_le_bytes());
            out[o + 48..o + 56].copy_from_slice(&a.deadline.to_le_bytes());
        }
        out
    }
}
