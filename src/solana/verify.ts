import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { hashMessage } from "./txBuilder.js";

export class SignedTxError extends Error {}

/**
 * Checks a transaction the user sent back before the sponsor co-signs it.
 * The sponsor must only ever sign the exact message the server built, so the
 * user cannot swap in different instructions after we approved the original.
 */
export function verifyUserSignedTx(args: {
  tx: VersionedTransaction;
  expectedMessageHash: string;
  sponsor: PublicKey;
  user: PublicKey;
}): void {
  const { tx, expectedMessageHash, sponsor, user } = args;
  if (hashMessage(tx) !== expectedMessageHash) {
    throw new SignedTxError("transaction message does not match the one built by the server");
  }

  const { staticAccountKeys, header } = tx.message;
  const signerKeys = staticAccountKeys.slice(0, header.numRequiredSignatures);
  if (!signerKeys[0]?.equals(sponsor)) throw new SignedTxError("fee payer is not the sponsor");
  if (!signerKeys.some((k) => k.equals(user))) throw new SignedTxError("user is not a signer");

  const message = tx.message.serialize();
  signerKeys.forEach((key, i) => {
    if (key.equals(sponsor)) return;
    const sig = tx.signatures[i];
    if (!sig || sig.every((b) => b === 0) || !nacl.sign.detached.verify(message, sig, key.toBytes())) {
      throw new SignedTxError(`missing or invalid signature for ${key.toBase58()}`);
    }
  });
}
