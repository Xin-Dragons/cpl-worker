import { Metaplex } from '@metaplex-foundation/js';
import { Connection } from '@solana/web3.js';

const connection = new Connection(process.env.RPC_HOST as string, 'confirmed')
export const metaplex = new Metaplex(connection);