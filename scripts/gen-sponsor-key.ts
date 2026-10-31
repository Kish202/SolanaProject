import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const kp = Keypair.generate();
console.log(`Public key (fund this with SOL): ${kp.publicKey.toBase58()}`);
console.log(`SPONSOR_SECRET_KEY=${bs58.encode(kp.secretKey)}`);
console.log("\nStore the secret in AWS Secrets Manager for real deployments. Never commit it.");
