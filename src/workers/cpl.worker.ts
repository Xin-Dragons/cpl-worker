import { getCollections, getMints, updateMints } from '../helpers';
import { HyperspaceClient, MarketPlaceActions } from "hyperspace-client-js";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Metadata, Metaplex } from '@metaplex-foundation/js';
import { chunk, flatten, orderBy } from 'lodash'
import { isAfter, sub } from 'date-fns';
import BN from 'bn.js';
import axios from 'axios';

const API_KEY = process.env.API_KEY as string;
const RPC_HOST = process.env.RPC_HOST as string;

const hsClient = new HyperspaceClient(API_KEY);

const connection = new Connection(RPC_HOST, 'confirmed')
const metaplex = new Metaplex(connection)

async function getItems({mints, collection}) {
  const state = await hsClient.getTokenHistory({
    condition: {
      tokenAddresses: mints.map(mint => mint.mint),
      actionType: 'TRANSACTION'
    }
  })

  const sales = flatten(
    state.getMarketPlaceActionsByToken.map(
      item => {
        const mint = mints.find(m => m.mint === item.token_address);

        return item.market_place_actions.filter((sale: MarketPlaceActions) => {
          if (!mint.sales.length) {
            return true;
          }
      
          // already run for this sale
          if (mint.sales.find(s => s.id === sale.signature)) {
            return false
          }
      
          const lastSale = orderBy(mint.sales, sale => sale.sale_date, "asc").pop()
      
          const prevSale = new Date(lastSale.sale_date);
          const thisSale = sale.block_timestamp ? new Date(sale.block_timestamp * 1000) : new Date();
      
          if (!prevSale || isAfter(thisSale, prevSale)) {
            return true;
          }
        }).filter(sale => {
          const now = new Date();
          const yesterday = sub(now, { hours: 730 })
          const saleTime = sale.block_timestamp ? new Date(sale.block_timestamp * 1000) : new Date();
    
          return isAfter(saleTime, yesterday)
        }).filter(Boolean).map(sale => ({ ...sale, token_address: item.token_address }))
      })
  ).filter(Boolean)

  if (!sales.length) {
    return;
  }

  const headers = {
    "Content-Type": "application/json",
  };

  const data = sales.map(sale => {
    return {
      "jsonrpc": "2.0",
      "id": 3,
      "method": "getTransaction",
      "params": [
        sale.signature
      ]
    }
  })

  const res = await axios.post(RPC_HOST, data, { headers });
  const nfts = (
    await metaplex.nfts().findAllByMintList({ mints: sales.map(s => new PublicKey(s.token_address)) })
  ).filter(Boolean) as Metadata[]

  const promises = res.data.map(async (item, index) => {
    const txn = item.result;
    const sale: MarketPlaceActions = sales[index]
    const sig = sale.signature;
    const salePrice = new BN(sale.price || 0 * LAMPORTS_PER_SOL)
    const tokenAddress = sale.token_address;
    const mint = mints.find(m => m.mint === tokenAddress);
    const hasDebt = mint.last_sale_transaction && mint.debt;
    const nft = nfts.find(n => n.mintAddress.toString() === tokenAddress)

    if (!nft) {
      return;
    }

    const metadata = nft.address

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
      .mul(royalties);

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
    } else {
      if (hasDebt) {
        console.log(`Clearing debt from ${tokenAddress}`)
      }
    }
    return {
      id: sig,
      mint: tokenAddress,
      debt,
      debt_lamports: debt_lamports ? debt_lamports.toNumber() : null,
      sale_date: new Date(txn.blockTime * 1000),
      seller_fee_basis_points: nft.sellerFeeBasisPoints,
      creators: nft.creators,
      sale_price: sale.price,
      buyer: sale.buyer_address,
      seller: sale.seller_address,
      royalties_paid: actualCommission ? actualCommission.toNumber() : null,
      expected_royalties: expectedCommission ? expectedCommission.toNumber() : null
    }
  })

  const toUpdate = (await Promise.all(promises)).filter(Boolean);

  await updateMints({ collection, items: toUpdate })
}

let retries = 3;
async function updateCollection(collection) {
  try {
    console.log(`Starting ${collection.id}`);
    const mints = await getMints(collection)
    const chunks = chunk(mints, 100);

    const promises = chunks.map(async items => {
      try {
        const res = await getItems({ mints: items, collection: collection.id })
        return res
      } catch {
        return getItems({ mints: items, collection: collection.id })
      }
    })

    await Promise.all(promises)

    console.log(`Finished ${collection.id}`);
  } catch (err) {
    console.log(err)
    if (--retries) {
      console.log('Error updating collection')
      return updateCollection(collection)
    } else {
      retries = 3;
      return;
    }
  }
}

export async function run() {
  try {
    const collections = (await getCollections())

    await collections.reduce((promise, collection) => {
      return promise.then(() => updateCollection(collection))
    }, Promise.resolve())

    return run();
  } catch (err) {
    console.error('App crashed, restarting')
    return run();
  }
}
