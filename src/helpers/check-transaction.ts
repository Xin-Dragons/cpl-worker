import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
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
  seller
}) {
  const salePrice = new BN((price || 0) * LAMPORTS_PER_SOL)

  if (!nft) {
    return;
  }

  const royalties = new BN(nft.sellerFeeBasisPoints)
  if (!txn) {
    return
  }

  const creatorAddresses = nft.creators.map(c => c.address.toString())

  const accountKeys = txn.transaction.message.accountKeys.map((k, i) => {
    const before = new BN(txn.meta.preBalances[i])
    const after = new BN(txn.meta.postBalances[i])
    return {
      key: k,
      change: after.sub(before)
    }
  })
  .filter(c => !c.change.isZero())

  const actualCommission = accountKeys.reduce((sum, item) => {
    if (creatorAddresses.includes(item.key)) {
      return sum.add(item.change)
    }
    return sum;
  }, new BN(0));

  const expectedCommission = salePrice
    .div(new BN(10000))
    .mul(royalties)

  const commissionOwing = expectedCommission.sub(actualCommission);

  let debt;
  let debt_lamports;
  if (commissionOwing.isZero() || commissionOwing.isNeg()) {
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
    sale_price: price,
    buyer,
    seller,
    royalties_paid: actualCommission ? actualCommission.toNumber() : null,
    expected_royalties: expectedCommission ? expectedCommission.toNumber() : null
  }
}

export async function recordSale({ mint, signature, price, buyer, seller }) {
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
    seller
  })

  console.log({ sale })

  await addSale({ sale, metadata: nft.json })
}