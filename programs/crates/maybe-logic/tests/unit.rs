//! Unit tests for the token-extension allowlist, Ed25519 instruction parsing
//! and agent policy checks.

use maybe_logic::attest::*;
use maybe_logic::plan::PlanView;
use maybe_logic::policy::*;
use maybe_logic::tokens::*;
use std::path::PathBuf;

fn mint_base(initialized: bool) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = 6; // decimals
    d[45] = initialized as u8;
    d
}

fn mint_2022(exts: &[(u16, usize)]) -> Vec<u8> {
    let mut d = mint_base(true);
    d.resize(165, 0);
    d.push(1); // AccountType::Mint
    for (t, len) in exts {
        d.extend_from_slice(&t.to_le_bytes());
        d.extend_from_slice(&(*len as u16).to_le_bytes());
        d.extend(std::iter::repeat_n(7u8, *len));
    }
    d
}

#[test]
fn classic_and_plain_token2022_mints_are_accepted() {
    assert_eq!(check_mint(&mint_base(true), false).unwrap().decimals, 6);
    assert!(check_mint(&mint_base(true), true).is_ok());
    assert_eq!(check_mint(&mint_base(false), false), Err(TokenErr::Uninitialized));
}

#[test]
fn metadata_only_token2022_mint_is_accepted() {
    // Pump create_v2 style: metadata pointer to itself + on-mint metadata
    let d = mint_2022(&[(EXT_METADATA_POINTER, 64), (EXT_TOKEN_METADATA, 120)]);
    assert!(check_mint(&d, true).is_ok());
    // classic program with trailing data is not a mint
    assert_eq!(check_mint(&d, false), Err(TokenErr::NotAMint));
}

#[test]
fn dangerous_extensions_are_rejected() {
    for t in [1u16, 3, 4, 6, 9, 10, 12, 14, 16, 25, 26, 28, 99] {
        let d = mint_2022(&[(EXT_METADATA_POINTER, 64), (t, 8)]);
        assert_eq!(check_mint(&d, true), Err(TokenErr::ForbiddenExtension(t)), "extension {t}");
    }
}

#[test]
fn malformed_tlv_is_rejected() {
    let mut d = mint_2022(&[(EXT_METADATA_POINTER, 64)]);
    let n = d.len();
    d[n - 64 - 2] = 0xff; // length beyond buffer
    assert_eq!(check_mint(&d, true), Err(TokenErr::MalformedExtensions));
}

fn ed_ix(entries: &[([u8; 32], &[u8])], index: u16) -> Vec<u8> {
    // build precompile data with all offsets pointing into this instruction
    let n = entries.len();
    let mut data = vec![n as u8, 0];
    let header = 2 + 14 * n;
    let mut body = Vec::new();
    let mut offs = Vec::new();
    for (pk, msg) in entries {
        let pk_off = header + body.len();
        body.extend_from_slice(pk);
        let sig_off = header + body.len();
        body.extend_from_slice(&[0u8; 64]);
        let msg_off = header + body.len();
        body.extend_from_slice(msg);
        offs.push((sig_off as u16, pk_off as u16, msg_off as u16, msg.len() as u16));
    }
    for (sig, pk, mo, ml) in offs {
        for v in [sig, index, pk, index, mo, ml, index] {
            data.extend_from_slice(&v.to_le_bytes());
        }
    }
    data.extend_from_slice(&body);
    data
}

#[test]
fn ed25519_offsets_must_point_into_the_same_instruction() {
    let k = [3u8; 32];
    let m = b"hello".as_slice();
    assert!(parse_ed25519(&ed_ix(&[(k, m)], u16::MAX)).is_ok());
    assert_eq!(parse_ed25519(&ed_ix(&[(k, m)], 0)), Err(Ed25519Err::ForeignOffsets));
    assert_eq!(parse_ed25519(&[1, 0, 1]), Err(Ed25519Err::Malformed));
}

#[test]
fn signer_counting_is_distinct_and_respects_revocation() {
    let keys = [[1u8; 32], [2u8; 32], [3u8; 32]];
    let msg = message(ATTEST_DOMAIN, &[9; 32], &[8; 32], &[7; 32], 1, 10, 11, 12);
    assert_eq!(msg.len(), 136);
    let other = message(ADJUDICATE_DOMAIN, &[9; 32], &[8; 32], &[7; 32], 1, 10, 11, 12);
    let e: Vec<([u8; 32], &[u8])> = vec![(keys[0], &msg), (keys[0], &msg), (keys[1], &msg), ([4u8; 32], &msg), (keys[2], &other)];
    assert_eq!(count_valid_signers(&e, &msg, &keys, 0), 2); // duplicate, stranger and wrong-domain ignored
    assert_eq!(count_valid_signers(&e, &msg, &keys, 0b010), 1); // key 1 revoked
}

fn yes_buys_token() -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/conformance/plans.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let hex = v.as_array().unwrap().iter().find(|x| x["id"] == "yes-buys-token").unwrap()["hex"].as_str().unwrap().to_string();
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn policy_bounds_agent_plans() {
    let bytes = yes_buys_token();
    let plan = PlanView::parse(&bytes).unwrap();
    let mints: Vec<[u8; 32]> = (0..plan.n_mints()).map(|i| plan.mint(i)).collect();
    let routes: Vec<[u8; 32]> = (0..plan.n_refs()).map(|i| plan.r#ref(i)).collect();
    let base = |max_total: [u64; 2], per: [u64; 2], spent: [u64; 2]| (max_total, per, spent);
    let check = |(mt, pa, sp): ([u64; 2], [u64; 2], [u64; 2]), revoked: bool, epoch: u32, mints: &[[u8; 32]], routes: &[[u8; 32]]| {
        let view = PolicyView {
            revoked,
            epoch,
            vault_epoch: 0,
            expires_at: plan.hdr.expires_at + 1,
            can_create: true,
            max_fee_bps: 30,
            allowed_mints: mints,
            allowed_routes: routes,
            allowed_recipients: &[],
            max_total: &mt,
            max_per_action: &pa,
            spent: &sp,
        };
        check_policy(&plan, &view, 0)
    };
    let ok = base([200_000_000, 0], [100_000_000, 0], [0, 0]);
    assert_eq!(check(ok, false, 0, &mints, &routes).unwrap()[0], 100_000_000);
    assert_eq!(check(ok, true, 0, &mints, &routes), Err(PolicyViolation::Revoked));
    assert_eq!(check(ok, false, 1, &mints, &routes), Err(PolicyViolation::StaleEpoch));
    assert_eq!(check(ok, false, 0, &mints[..1], &routes), Err(PolicyViolation::AssetNotAllowed));
    assert_eq!(check(ok, false, 0, &mints, &[]), Err(PolicyViolation::RouteNotAllowed));
    assert_eq!(check(base([200_000_000, 0], [50_000_000, 0], [0, 0]), false, 0, &mints, &routes), Err(PolicyViolation::PerActionCap));
    assert_eq!(check(base([200_000_000, 0], [100_000_000, 0], [150_000_000, 0]), false, 0, &mints, &routes), Err(PolicyViolation::TotalCap));
}
