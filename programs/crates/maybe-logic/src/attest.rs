//! Signed-attestation messages and Ed25519 precompile instruction parsing.
//!
//! An attestation is accepted only if an Ed25519 precompile instruction in the
//! SAME transaction verified signatures over exactly the expected message, and
//! every offset in that instruction points into the instruction itself
//! (instruction index == u16::MAX). Otherwise a crafted instruction could make
//! the precompile verify one buffer while the program reads another.

pub const ATTEST_DOMAIN: &[u8] = b"MAYBE_ATTEST_V1";
pub const ADJUDICATE_DOMAIN: &[u8] = b"MAYBE_ADJUDICATE_V1";

#[allow(clippy::too_many_arguments)]
pub fn message(
    domain: &[u8],
    program_id: &[u8; 32],
    event: &[u8; 32],
    rule_hash: &[u8; 32],
    outcome: u8,
    observed_at: i64,
    nonce: u64,
    expires_at: i64,
) -> Vec<u8> {
    let mut m = Vec::with_capacity(domain.len() + 32 * 3 + 1 + 24);
    m.extend_from_slice(domain);
    m.extend_from_slice(program_id);
    m.extend_from_slice(event);
    m.extend_from_slice(rule_hash);
    m.push(outcome);
    m.extend_from_slice(&observed_at.to_le_bytes());
    m.extend_from_slice(&nonce.to_le_bytes());
    m.extend_from_slice(&expires_at.to_le_bytes());
    m
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ed25519Err {
    Malformed,
    ForeignOffsets,
}

/// Extract (signer pubkey, message slice) pairs from Ed25519 precompile data.
/// Layout: num_signatures u8, padding u8, then per signature 7 × u16 offsets
/// (sig_off, sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix).
pub fn parse_ed25519(data: &[u8]) -> Result<Vec<([u8; 32], &[u8])>, Ed25519Err> {
    if data.len() < 2 {
        return Err(Ed25519Err::Malformed);
    }
    let n = data[0] as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let base = 2 + i * 14;
        if base + 14 > data.len() {
            return Err(Ed25519Err::Malformed);
        }
        let u = |o: usize| u16::from_le_bytes([data[base + o], data[base + o + 1]]);
        let (sig_off, sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) = (u(0), u(2), u(4), u(6), u(8), u(10), u(12));
        if sig_ix != u16::MAX || pk_ix != u16::MAX || msg_ix != u16::MAX {
            return Err(Ed25519Err::ForeignOffsets);
        }
        let (pk_off, msg_off, msg_len, sig_off) = (pk_off as usize, msg_off as usize, msg_len as usize, sig_off as usize);
        if pk_off + 32 > data.len() || msg_off + msg_len > data.len() || sig_off + 64 > data.len() {
            return Err(Ed25519Err::Malformed);
        }
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&data[pk_off..pk_off + 32]);
        out.push((pk, &data[msg_off..msg_off + msg_len]));
    }
    Ok(out)
}

/// Count distinct allowed signers over `expected`. `allowed` is the attestor
/// set; `revoked` is a bitmap over its indices.
pub fn count_valid_signers(entries: &[([u8; 32], &[u8])], expected: &[u8], allowed: &[[u8; 32]], revoked: u8) -> usize {
    let mut seen: u8 = 0;
    let mut count = 0;
    for (pk, msg) in entries {
        if *msg != expected {
            continue;
        }
        if let Some(idx) = allowed.iter().position(|k| k == pk) {
            let bit = 1u8 << idx;
            if revoked & bit != 0 || seen & bit != 0 {
                continue;
            }
            seen |= bit;
            count += 1;
        }
    }
    count
}
