import { getCollections, getSaleForTransaction, getMints, addSales } from '../helpers';
import { HyperspaceClient, MarketPlaceActions } from "hyperspace-client-js";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { auctionHouseModule, Metadata, Metaplex } from '@metaplex-foundation/js';
import { chunk, flatten, isEmpty, orderBy, partition } from 'lodash'
import { isAfter, isThisMinute, sub } from 'date-fns';
import axios from 'axios';
import BN from 'bn.js';

const API_KEY = process.env.API_KEY as string;
const RPC_HOST = process.env.RPC_HOST as string;
const CC_PROGRAM_ADDRESS = "mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc";

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
          const isMmm = sale.marketplace_program_id === CC_PROGRAM_ADDRESS;
      
          // already run for this sale
          if (mint.sales.find(s => s.id === sale.signature) && (!isMmm || mint.sales.find(s => s.id === sale.signature).patched)) {
            return false
          }
      
          const lastSale = orderBy(mint.sales, sale => sale.sale_date, "asc").pop()
      
          const prevSale = new Date(lastSale.sale_date);
          const thisSale = sale.block_timestamp ? new Date(sale.block_timestamp * 1000) : new Date();
      
          if (!prevSale || isAfter(thisSale, prevSale) || isMmm) {
            return true;
          }
        }).filter(sale => {
          const now = new Date();
          const yesterday = sub(now, { hours: 900 })
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
      "id": sale.token_address,
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

  const promises = res.data.map(async (item: any, index: number) => {
    const sale = sales[index]
    const tokenAddress = sale.token_address
    const nft = nfts.find(n => n.mintAddress.toString() === tokenAddress) as Metadata

    let txn = item.result;

    if (!txn && item.error?.message?.includes('Transaction version (0)')) {
      const data = {
        "jsonrpc": "2.0",
        "method": "getTransaction",
        "id": sale.token_address,
        "params": [
          sale.signature,
          {
            maxSupportedTransactionVersion: 0
          }
        ]
      }
      const res = await axios.post(RPC_HOST, data, { headers })
      txn = res.data.result;
    }

    if (!txn) {
      return
    }

    let price = sale.price as number * LAMPORTS_PER_SOL;
    let royaltiesPaid: BN | undefined;

    if (sale.marketplace_program_id === CC_PROGRAM_ADDRESS) {
      const msg = txn.meta.logMessages.find(msg => {
        return msg.includes('"total_price"')
      })
      const parsed = JSON.parse(msg.replace("Program log: ", ""))
      price = parsed.total_price;
      royaltiesPaid = new BN(parsed.royalty_paid);
    }

    let effectiveRoyalties: any;

    if (collection["historical-royalties"].length) {
      const saleDate = txn.blockTime * 1000;
      effectiveRoyalties = collection["historical-royalties"].find((item: any) => {
        const startDate = item.active_from ? Date.parse(item.active_from) : 0;
        const endDate = item.active_to ? Date.parse(item.active_to) : Infinity;
        return startDate <= saleDate && endDate > saleDate
      })
    }

    return getSaleForTransaction({
      signature: sale.signature as string,
      txn,
      nft,
      tokenAddress,
      price: new BN(price),
      buyer: sale.buyer_address as string,
      seller: sale.seller_address as string,
      royaltiesPaid,
      effectiveRoyalties
    })
  })

  const toUpdate = (await Promise.all(promises)).filter(Boolean);

  await addSales({ items: toUpdate })
}

let retries = 3;
async function updateCollection(collection) {
  try {
    console.log(`Starting ${collection.id}`);
    const mints = await getMints({collection})
    const chunks = chunk(mints, 100);

    const promises = chunks.map(async items => {
      try {
        const res = await getItems({ mints: items, collection })
        return res
      } catch {
        return getItems({ mints: items, collection })
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
    console.log(err)
    console.error('App crashed, restarting')
    return run();
  }
}
