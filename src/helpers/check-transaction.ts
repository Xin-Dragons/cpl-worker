import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { Metadata } from "@metaplex-foundation/js";
import { getMint, addSale } from '../helpers';
import BN from "bn.js";
import { metaplex } from "./metaplex";

const connection = new Connection(process.env.RPC_HOST as string, 'confirmed')

export async function getSaleForTransaction({
  txn,
  signature,
  tokenAddress,
  price,
  nft,
  buyer,
  seller,
  royaltiesPaid,
  fromWebhook = false,
  effectiveRoyalties
}: {
  signature: string,
  tokenAddress: string,
  txn: any,
  nft: Metadata,
  price: BN | number,
  buyer: string,
  seller: string,
  fromWebhook?: boolean,
  royaltiesPaid?: BN,
  effectiveRoyalties?: any,
}) {
  const salePrice = price instanceof BN
    ? price
    : new BN((price || 0) * LAMPORTS_PER_SOL)

  if (!nft) {
    return;
  }

  const royalties = new BN(effectiveRoyalties?.seller_fee_basis_points || nft.sellerFeeBasisPoints)
  if (!txn) {
    return
  }

  const creatorAddresses = effectiveRoyalties?.creators?.map(c => c.address) || nft.creators.map(c => c.address.toString())

  const accountKeys = txn.transaction.message.accountKeys.map((k, i) => {
    const before = new BN(txn.meta.preBalances[i])
    const after = new BN(txn.meta.postBalances[i])
    return {
      key: k,
      change: after.sub(before)
    }
  })
  .filter(c => !c.change.isZero())

  const actualCommission = royaltiesPaid || accountKeys.reduce((sum, item) => {
    if (creatorAddresses.includes(item.key.toString())) {
      if (item.key.toString() === buyer) {
        return sum.add(item.change.add(price))
      }
      return sum.add(item.change)
    }
    return sum;
  }, new BN(0));

  const expectedCommission = salePrice
    .div(new BN(10000))
    .mul(royalties)

  const commissionOwing = expectedCommission.sub(actualCommission);

  let debt: number | null;
  let debt_lamports: BN | null;
  if (commissionOwing.isZero() || commissionOwing.isNeg() || commissionOwing.lte(new BN(5000))) {
    debt = null;
    debt_lamports = null;
  } else {
    debt = commissionOwing.toNumber() / LAMPORTS_PER_SOL;
    debt_lamports = commissionOwing;
  }
  if (debt) {
    console.log(`Adding debt: ${debt} to mint: ${tokenAddress}`);
  }

  return {
    id: signature,
    mint: tokenAddress,
    debt,
    debt_lamports: debt_lamports ? debt_lamports.toNumber() : null,
    sale_date: new Date(txn.blockTime * 1000),
    seller_fee_basis_points: nft.sellerFeeBasisPoints,
    creators: nft.creators,
    sale_price: price instanceof BN ? price.toNumber() / LAMPORTS_PER_SOL : price,
    buyer,
    seller,
    royalties_paid: (actualCommission ? actualCommission.toNumber() : null),
    expected_royalties: expectedCommission ? expectedCommission.toNumber() : null
  }
}

export async function recordSale({ mint, signature, price, buyer, seller }) {
  try {
    const mintFromDb = await getMint({ mint });
    // mint not included
    if (!mintFromDb) {
      return
    }
  
    if (mintFromDb?.sales?.find(s => s.id === signature)) {
      console.log('Already recorded, skipping');
      return;
    }
  
    const nft = await metaplex.nfts().findByMint({ mintAddress: new PublicKey(mint) });
    const txn = await connection.getTransaction(signature);
  
    const sale = await getSaleForTransaction({
      signature,
      tokenAddress: mint,
      txn,
      nft,
      price,
      buyer,
      seller,
      fromWebhook: true
    })
    
    if (!sale) {
      return;
    }
  
    await addSale({ sale, metadata: nft.json })
  } catch (err) {
    console.log(err)
  }
}