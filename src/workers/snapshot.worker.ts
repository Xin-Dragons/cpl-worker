import { getPrograms, subscribeToProgram, getCollections, getMints, updateMints } from '../helpers';
import { HyperspaceClient, type MarketplaceActionEnums } from "hyperspace-client-js";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Metaplex } from '@metaplex-foundation/js';
import { chunk } from 'lodash'
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

  // only run for new sales since last pass
  const items = state.getMarketPlaceActionsByToken.filter(item => {
    const mint = mints.find(m => m.mint === item.token_address);
    // no previous activity
    if (!mint.last_sale_transaction) {
      return true;
    }

    // already run for this sale
    if (mint.last_sale_transaction === item.market_place_actions[0].signature) {
      return false;
    }

    const prevSale = new Date(mint.last_sale_date);
    const thisSale = new Date(item.block_timestamp * 1000);

    if (!prevSale || isAfter(thisSale, prevSale)) {
      return true;
    }

    return false;

  });

  const sales = items.map(item => item.market_place_actions[0])
    .filter(sale => {
      const now = new Date()
      const yesterday = sub(now, { hours: 48 })
      const saleTime = new Date(sale.block_timestamp * 1000);

      return isAfter(saleTime, yesterday)
    });

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
    const tokenAddress = items[index].token_address;
    const mint = mints.find(m => m.mint === tokenAddress);
    const hasDebt = mint.last_sale_transaction && mint.debt;
    const nft = nfts.find(n => n.mintAddress.toString() === tokenAddress);

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
      // console.log(k, after.sub(before).toNumber())
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
    return { mint: tokenAddress, debt, last_sale_transaction: sig, last_sale_date: new Date(txn.blockTime * 1000), show_flag: showFlag }
  })

  const toUpdate = (await Promise.all(promises)).filter(Boolean);

  await updateMints({ collection, items: toUpdate })
}

let retries = 3;
async function updateCollection(collection) {
  try {
    console.log(`Starting ${collection.slug}`);
    const mints = await getMints(collection)
    const chunks = chunk(mints, 100);

    const nfts = (
      await metaplex.nfts().findAllByMintList({ mints: mints.map(mint => new PublicKey(mint.mint) )})
    )
      .filter(Boolean);

    const promises = chunks.map(async items => {
      try {
        const res = await getItems({ mints: items, nfts, collection: collection.id })
        return res
      } catch {
        return getItems({ mints: items, nfts, collection: collection.id })
      }
    })

    await Promise.all(promises)

    console.log(`Finished ${collection.slug}`);
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
    const collections = (
      await getCollections()
    )

    await collections.reduce((promise, collection) => {
      return promise.then(() => updateCollection(collection))
    }, Promise.resolve())

    return run();
  } catch (err) {
    console.error('App crashed, restarting')
    return run();
  }
}
