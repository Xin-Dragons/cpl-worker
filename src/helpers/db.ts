import fs from 'fs';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Metaplex } from '@metaplex-foundation/js';
import { getAssociatedTokenAddress } from '@solana/spl-token'
import { pick, flatten, findKey, uniqBy, chunk, get, groupBy } from 'lodash';
import { add, isBefore, sub, isAfter, differenceInSeconds } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import Bottleneck from 'bottleneck'
import axios from 'axios';

const supabaseUrl = process.env.DB_URL as string;
const supabaseServiceKey = process.env.DB_SECRET as string;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const connection = new Connection(process.env.RPC_HOST as string);
const metaplex = new Metaplex(connection);

const ACC_RENT = 2039280;
const TXN_FEE = 5000;

export async function getCollections() {
  const { data, error } = await supabase
    .from('collections')
    .select('id')

  if (error) {
    throw new Error('Error looking up collections')
  }

  return data;
}

export async function getMints({ collection }) {
  const { data, error } = await supabase
    .from('nfts')
    .select('*, sales(*)')
    .eq('collection', collection.id)

  if (error) {
    console.log(error)
    throw new Error('Error getting mints')
  }

  return data
}

export async function getMint({ mint }) {
  const { data, error } = await supabase
    .from('nfts')
    .select('*, sales(*)')
    .eq('mint', mint)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.log(error)
    throw new Error('Error getting mint')
  }

  return data
}

export async function updateMints({ collection, items }) {
  const { data, error } = await supabase
    .from('sales')
    .upsert(items.map(item => {
      return {
        ...item
      }
    }))

  if (error) {
    console.log(error)
    throw new Error('Error updating mints')
  }
}