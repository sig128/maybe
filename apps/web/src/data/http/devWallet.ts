import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Encode, base58Decode, utf8ToBytes } from "@maybe/core";

/**
 * Local-validator development wallet. A throwaway ed25519 key kept in this
 * browser's storage, used ONLY against a local validator. It is labelled as
 * such everywhere and the server refuses dev-wallet sessions outside localnet.
 */
const KEY = "maybe.devwallet.v1";
const SESSION_KEY = "maybe.devwallet.session.v1";

export class DevWallet {
  private secret: Uint8Array | null = null;
  address: string | null = null;
  private session_: string | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.load(base58Decode(raw));
      this.session_ = localStorage.getItem(SESSION_KEY);
    } catch {
      /* storage unavailable: a fresh key per session */
    }
  }

  /** sign-in session for this local API (a bearer token; it can't move funds by itself) */
  get session(): string | null {
    return this.session_;
  }
  set session(v: string | null) {
    this.session_ = v;
    try {
      if (v) localStorage.setItem(SESSION_KEY, v);
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  private load(secret: Uint8Array) {
    this.secret = secret;
    this.address = base58Encode(ed25519.getPublicKey(secret));
  }

  async ensure(): Promise<{ address: string }> {
    if (!this.secret) {
      const s = ed25519.utils.randomSecretKey();
      this.load(s);
      try {
        localStorage.setItem(KEY, base58Encode(s));
      } catch {
        /* ignore */
      }
    }
    return { address: this.address! };
  }

  signMessage(message: string): string {
    if (!this.secret) throw new Error("No dev wallet");
    return base58Encode(ed25519.sign(utf8ToBytes(message), this.secret));
  }

  /**
   * Sign a serialized legacy/v0 transaction message. The server sends
   * { message: base64 } where message is the exact bytes to sign; we return
   * the signature for the fee-payer/owner slot, which the server places.
   */
  signTransaction(payload: string): string {
    if (!this.secret) throw new Error("No dev wallet");
    const { message } = JSON.parse(atob(payload)) as { message: string };
    const bytes = Uint8Array.from(atob(message), (c) => c.charCodeAt(0));
    return JSON.stringify({ signer: this.address, signature: base58Encode(ed25519.sign(bytes, this.secret)) });
  }
}
