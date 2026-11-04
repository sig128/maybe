//! Token account / mint parsing and the Token-2022 extension allowlist
//! (mirrors `ALLOWED_TOKEN2022_EXTENSIONS` in packages/core/src/assets.ts).

/// Token-2022 ExtensionType values (spl-token-2022 `ExtensionType`).
pub const EXT_UNINITIALIZED: u16 = 0;
pub const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
pub const EXT_METADATA_POINTER: u16 = 18;
pub const EXT_TOKEN_METADATA: u16 = 19;
pub const EXT_GROUP_POINTER: u16 = 20;
pub const EXT_TOKEN_GROUP: u16 = 21;
pub const EXT_GROUP_MEMBER_POINTER: u16 = 22;
pub const EXT_TOKEN_GROUP_MEMBER: u16 = 23;

/// Informational extensions only. Everything else — transfer fees, hooks,
/// permanent delegates, non-transferable, default-frozen, confidential,
/// pausable, scaled/interest-bearing amounts, close authority, permissioned
/// burn, and any extension unknown to this build — is rejected.
pub const ALLOWED_MINT_EXTENSIONS: [u16; 6] = [
    EXT_METADATA_POINTER,
    EXT_TOKEN_METADATA,
    EXT_GROUP_POINTER,
    EXT_TOKEN_GROUP,
    EXT_GROUP_MEMBER_POINTER,
    EXT_TOKEN_GROUP_MEMBER,
];

pub const MINT_BASE_LEN: usize = 82;
pub const ACCOUNT_BASE_LEN: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenErr {
    NotAMint,
    Uninitialized,
    MalformedExtensions,
    ForbiddenExtension(u16),
    NotATokenAccount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MintInfo {
    pub decimals: u8,
    pub has_freeze_authority: bool,
}

/// Validate a mint for vault use. `is_token_2022` selects the program rules.
pub fn check_mint(data: &[u8], is_token_2022: bool) -> Result<MintInfo, TokenErr> {
    if data.len() < MINT_BASE_LEN {
        return Err(TokenErr::NotAMint);
    }
    if data[45] != 1 {
        return Err(TokenErr::Uninitialized);
    }
    let info = MintInfo { decimals: data[44], has_freeze_authority: data[46] == 1 };
    if data.len() == MINT_BASE_LEN {
        return Ok(info);
    }
    if !is_token_2022 {
        return Err(TokenErr::NotAMint);
    }
    if data.len() < ACCOUNT_BASE_LEN + 1 || data[ACCOUNT_BASE_LEN] != ACCOUNT_TYPE_MINT {
        return Err(TokenErr::MalformedExtensions);
    }
    if data[MINT_BASE_LEN..ACCOUNT_BASE_LEN].iter().any(|b| *b != 0) {
        return Err(TokenErr::MalformedExtensions);
    }
    for t in extension_types(&data[ACCOUNT_BASE_LEN + 1..])? {
        if !ALLOWED_MINT_EXTENSIONS.contains(&t) {
            return Err(TokenErr::ForbiddenExtension(t));
        }
    }
    Ok(info)
}

/// Parse a TLV region into extension type ids (stops at an uninitialized entry).
pub fn extension_types(tlv: &[u8]) -> Result<Vec<u16>, TokenErr> {
    let mut out = Vec::new();
    let mut o = 0usize;
    while o + 4 <= tlv.len() {
        let t = u16::from_le_bytes([tlv[o], tlv[o + 1]]);
        if t == EXT_UNINITIALIZED {
            break;
        }
        let l = u16::from_le_bytes([tlv[o + 2], tlv[o + 3]]) as usize;
        o += 4;
        if o + l > tlv.len() {
            return Err(TokenErr::MalformedExtensions);
        }
        out.push(t);
        o += l;
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenAccountInfo {
    pub mint: [u8; 32],
    pub owner: [u8; 32],
    pub amount: u64,
    /// 1 initialized, 2 frozen
    pub state: u8,
}

pub fn parse_token_account(data: &[u8]) -> Result<TokenAccountInfo, TokenErr> {
    if data.len() < ACCOUNT_BASE_LEN {
        return Err(TokenErr::NotATokenAccount);
    }
    // Token-2022 accounts with extensions carry AccountType::Account (2) at byte 165
    if data.len() > ACCOUNT_BASE_LEN && data[ACCOUNT_BASE_LEN] != 2 {
        return Err(TokenErr::NotATokenAccount);
    }
    let mut mint = [0u8; 32];
    let mut owner = [0u8; 32];
    mint.copy_from_slice(&data[0..32]);
    owner.copy_from_slice(&data[32..64]);
    let mut a = [0u8; 8];
    a.copy_from_slice(&data[64..72]);
    let state = data[108];
    if state == 0 {
        return Err(TokenErr::NotATokenAccount);
    }
    Ok(TokenAccountInfo { mint, owner, amount: u64::from_le_bytes(a), state })
}

/// `transfer_checked` instruction data (identical for Token and Token-2022).
pub fn transfer_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    let mut d = [0u8; 10];
    d[0] = 12;
    d[1..9].copy_from_slice(&amount.to_le_bytes());
    d[9] = decimals;
    d
}

pub fn mint_to_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    let mut d = transfer_checked_data(amount, decimals);
    d[0] = 14;
    d
}

pub fn burn_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    let mut d = transfer_checked_data(amount, decimals);
    d[0] = 15;
    d
}
