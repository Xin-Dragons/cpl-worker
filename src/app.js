import { getPrograms, subscribeToProgram, getCollections, getMints, updateMints } from './helpers';
import { HyperspaceClient } from "hyperspace-client-js";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createTokenWithMintOperationHandler, Metaplex } from '@metaplex-foundation/js';
import { chunk, flatten, orderBy } from 'lodash';
import { isAfter, sub } from 'date-fns';
import BN from 'bn.js';
import axios from 'axios';

const { API_KEY, RPC_HOST } = process.env;

const ACC_RENT = 2039280;

const METAPLEX_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

const hsClient = new HyperspaceClient(API_KEY);

async function runProgram(program) {
  try {
    console.log(`Polling ${program.name}`)

    await subscribeToProgram(program)

  } catch (err) {
    console.log(err)
    runProgram(program)
  }

}

const connection = new Connection(process.env.RPC_HOST)
const metaplex = new Metaplex(connection)

async function getItems({mints, nfts, collection}) {
  const state = await hsClient.getTokenHistory({
    condition: {
      tokenAddresses: mints.map(mint => mint.mint),
      actionType: 'TRANSACTION'
    }
  })

  const items = state.getMarketPlaceActionsByToken;
  
  const sales = flatten(
    items.map(
      item => {
        const mint = mints.find(m => m.mint === item.token_address);

        return item.market_place_actions.filter(sale => {
          if (!mint.sales.length) {
            return true;
          }
      
          // already run for this sale
          if (mint.sales.find(s => s.id === sale.signature)) {
            return false
          }
      
          const lastSale = orderBy(mint.sales, sale => sale.sale_date, "asc").pop()
      
          const prevSale = new Date(lastSale.sale_date);
          const thisSale = new Date(sale.block_timestamp * 1000);
      
          if (!prevSale || isAfter(thisSale, prevSale)) {
            return true;
          }
        }).filter(sale => {
          const now = new Date();
          const yesterday = sub(now, { hours: 730 })
          const saleTime = new Date(sale.block_timestamp * 1000);
    
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

  const promises = res.data.map(async (item, index) => {
    const txn = item.result;
    const sale = sales[index]
    const sig = sale.signature;
    const salePrice = new BN(sale.price * LAMPORTS_PER_SOL)
    const tokenAddress = sale.token_address;
    const mint = mints.find(m => m.mint === tokenAddress);
    const hasDebt = mint.last_sale_transaction && mint.debt;
    const nft = nfts.find(n => n.mintAddress.toString() === tokenAddress);

    if (!nft) {
      return;
    }

    const metadata = nft.address

    const lastSigs = await connection.getSignaturesForAddress(metadata, { until: sig })

    const showFlag = !!lastSigs.length;

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
    if (commissionOwing.isZero() || commissionOwing.isNeg()) {
      debt = null;
    } else {
      debt = commissionOwing.toNumber() / LAMPORTS_PER_SOL;
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
      sale_date: new Date(txn.blockTime * 1000),
      seller_fee_basis_points: nft.sellerFeeBasisPoints,
      creators: nft.creators,
      sale_price: sale.price,
      buyer: sale.buyer_address,
      seller: sale.seller_address,
      royalties_paid: actualCommission.toNumber()
    }
  })

  const toUpdate = (await Promise.all(promises)).filter(Boolean);

  await updateMints({ collection, items: toUpdate })
}

let retries = 3;
export async function updateCollection(collection) {
  try {
    console.log(`Starting ${collection}`);
    const mints = (await getMints(collection))
    const chunks = chunk(mints, 100);

    const nfts = (
      await metaplex.nfts().findAllByMintList({ mints: mints.map(mint => new PublicKey(mint.mint) )})
    )
      .filter(Boolean);

    const promises = chunks.map(async items => {
      try {
        const res = await getItems({ mints: items, nfts, collection })
        return res
      } catch {
        return getItems({ mints: items, nfts, collection })
      }
    })

    await Promise.all(promises)

    console.log(`Finished ${collection}`);
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