import fs from 'fs';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Metaplex } from '@metaplex-foundation/js';
import { getAssociatedTokenAddress } from '@solana/spl-token'
import { pick, flatten, findKey, uniqBy, chunk, get, groupBy } from 'lodash';
import { add, isBefore, sub, isAfter, differenceInSeconds } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import Bottleneck from 'bottleneck'
import axios from 'axios';

const supabaseUrl = process.env.DB_URL;
const supabaseServiceKey = process.env.DB_SECRET;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const connection = new Connection(process.env.RPC_HOST);
const metaplex = new Metaplex(connection);

const ACC_RENT = 2039280;
const TXN_FEE = 5000;

async function getNftOwner(address) {
  const connection = new Connection(process.env.RPC_HOST);

  const TOKEN_PUBKEY = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );

  const filters = [
    {
      memcmp: {
        offset: 0,
        bytes: address,
      },
    },
    {
      dataSize: 165,
    }
  ];
  const programAccountsConfig = {
    filters,
    encoding: 'jsonParsed'
  };
  const listOfTokens = await connection.getParsedProgramAccounts(
    TOKEN_PUBKEY,
    programAccountsConfig
  );

  const found = listOfTokens.find(token => {
    const amount = get(token, 'account.data.parsed.info.tokenAmount.amount');
    return amount === 1 || amount === '1';
  });

  return get(found, 'account.data.parsed.info.owner')
}

export async function getPrograms() {
  const { data, error } = await supabase
    .from('programs')
    .select('*')
    .eq('active', true)

  if (error) {
    throw new Error('Nope')
  }

  return data;
}

const limiter = new Bottleneck({
  minTime: 70
})

export async function getMints(collection) {
  const { data, error } = await supabase
    .from('mints')
    .select('mint')
    .eq('collection', collection.id)

  if (error) {
    throw new Error('Error getting mints')
  }

  return data.map(d => d.mint);
}

export async function updateMint({ publicKey, debt }) {
  const { data, error } = await supabase
    .from('mints')
    .update({ debt, listed: false })
    .eq('mint', publicKey);

  if (error) {
    console.log(error)
    throw new Error('failed to update mint', mint)
  }
}

export async function markListed({ publicKey }) {
  const { data, error } = await supabase
    .from('mints')
    .update({
      listed: true
    })
    .eq('mint', publicKey)

  if (error) {
    console.log(error)
    throw new Error(error)
  }
}

export async function markDelisted({ publicKey }) {
  const { data, error } = await supabase
    .from('mints')
    .update({
      listed: false
    })
    .eq('mint', publicKey)

  if (error) {
    console.log(error)
    throw new Error(error)
  }
}

export async function markSold({ publicKey, txn }) {
  const tokens = txn.meta.preTokenBalances;

  const mint = tokens[0].mint;
  if (mint !== publicKey) {
    return;
  }

  const nft = await metaplex.nfts().findByMint({ mintAddress: new PublicKey(publicKey) }).run()
  const royalties = nft.sellerFeeBasisPoints / 100;
  const creatorAddresses = nft.creators.map(c => c.address.toString())
  const accountKeys = txn.transaction.message.accountKeys.map((k, i) => {
    const before = txn.meta.preBalances[i]
    const after = txn.meta.postBalances[i]
    return {
      key: k.pubkey.toString(),
      change: after - before
    }
  })
  .filter(c => c.change)

  const actualCommission = accountKeys.reduce((sum, item) => {
    if (creatorAddresses.includes(item.key)) {
      return sum + item.change
    }
    return sum;
  }, 0)

  const salePrice = Math.abs(Math.min(...accountKeys.map(k => k.change))) - ACC_RENT - TXN_FEE
  const expectedCommission = salePrice / 100 * royalties;

  const commissionOwing = expectedCommission - actualCommission;

  if (!commissionOwing) {
    return
  }

  const debt = commissionOwing / LAMPORTS_PER_SOL;
  console.log(`Adding debt: ${debt} to mint: ${mint}`);
  await updateMint({ publicKey: mint, debt });
}

export async function getMint({ mint }) {
  const { data, error } = await supabase
    .from('mints')
    .select(`
      *,
      collection (
        active
      )
    `)
    .eq('mint', mint)

  if (error) {
    throw new Error('Error looking up mint')
  }

  return data && data[0]
}

export async function checkLog({ sig }) {
  const { data, error } = await supabase
    .from('log')
    .select('sig')
    .eq('sig', sig);

  if (error) {
    console.log(error)
    throw new Error('Error looking up sig')
  }

  return data && data[0];
}

export async function addToLog({ sig, mint, type }) {
  const { data, error } = await supabase
    .from('log')
    .insert({
      sig,
      mint,
      type
    })

  if (error) {
    throw new Error('Error logging', sig)
  }

  return data;
}

export async function lookupOrAddCollection({ nft }) {
  if (nft.collection) {
    if (!nft.collection.verified) {
      return;
    }

    const { data, error } = await supabase
      .from('collections')
      .select('*')
      .eq('id', nft.collection.address.toString())

    if (error) {
      throw new Error('Error looking up by creator')
    }

    if (data && data.length) {
      return data[0];
    }

    const collectionNft = await metaplex.nfts().findByMint({ mintAddress: nft.collection.address }).run();

    if (!collectionNft) {
      return;
    }

    const { data: update, error: updateError } = await supabase
      .from('collections')
      .insert({
        id: nft.collection.address.toString(),
        lookup_type: 'collection',
        slug: collectionNft.name.toLowerCase().replace(/\s+/g, '-'),
        active: false,
        update_authority: nft.updateAuthorityAddress.toString(),
        name: collectionNft.name
      })

    if (updateError) {
      throw new Error('Error inserting by collection')
    }

    return data && data[0]

  } else {
    const firstVerifiedCreator = nft.creators.find(c => c.verified);
    if (!firstVerifiedCreator) {
      return;
    }

    const { data, error } = await supabase
      .from('collections')
      .select('*')
      .eq('id', firstVerifiedCreator.address.toString())

    console.log(data)

    if (error) {
      throw new Error('Error looking up by creator')
    }

    if (data && data.length) {
      return data[0];
    }

    const collectionName = nft.json.collection
      ? nft.json.collection.name
      : nft.name.split(' #')[0];

    const { data: insert, error: insertError } = await supabase
      .from('collections')
      .insert({
        id: firstVerifiedCreator.address.toString(),
        lookup_type: 'creator',
        slug: collectionName.toLowerCase().replace(/\s+/g, '-'),
        active: false,
        update_authority: nft.updateAuthorityAddress.toString(),
        name: collectionName
      });

    if (insertError) {
      console.log(insertError)
      throw new Error('Error inserting by creator');
    }

    return data && data[0];
  }
}

export async function addMint({ mint }) {
  const mintAddress = new PublicKey(mint)
  const nft = await metaplex.nfts().findByMint({ mintAddress }).run()

  const collection = await lookupOrAddCollection({ nft });

  if (!collection) {
    return;
  }

  const { data, error } = await supabase
    .from('mints')
    .insert({
      collection: collection.id,
      mint,
      metadata_url: nft.uri,
      name: nft.name,
      number: parseInt(nft.name.split('#')[1])
    })

  if (error) {
    throw new Error('Error adding mint')
  }

  return data && data[0]
}

export async function subscribeToProgram({ id, name, purchase_log, listing_log, delisting_log }) {
  connection.onProgramAccountChange(new PublicKey(id), async (a, context) => {
    const slot = await connection.getSlot()
    const sigs = await connection.getSignaturesForAddress(a.accountInfo.owner, { limit: 1 })
    const sig = sigs[0];
    if (!sig) {
      return;
    }

    const signature = sig.signature;

    const inLog = await checkLog({ sig: signature });

    if (inLog) {
      return;
    }

    const txn = await connection.getParsedTransaction(signature)
    if (!txn) {
      return;
    }

    const type = findKey({
      purchase: purchase_log,
      list: listing_log,
      delist: delisting_log
    }, (item) => txn.meta.logMessages.includes(item));

    if (!type) {
      return;
    }

    const tokens = txn.meta.preTokenBalances;
    if (!tokens) {
      return;
    }

    const mint = tokens[0].mint;
    const isProtected = await getMint({ mint })

    if (!isProtected) {
      const item = await addMint({ mint });

      if (!item) {
        return;
      }
      console.log('added mint', mint)
    }

    if (type === 'purchase') {
      await markSold({ publicKey: mint, txn })
    }

    if (type === 'list') {
      console.log(`marking listed: ${mint}`);
      await markListed({ publicKey: mint });
    }

    if (type === 'delist') {
      console.log(`marking delisted: ${mint}`);
      await markDelisted({ publicKey: mint });
    }

    await addToLog({ sig: signature, mint, type })
  }, 'confirmed')
}