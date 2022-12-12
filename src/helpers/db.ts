import fs from 'fs';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Metaplex } from '@metaplex-foundation/js';
import { getAssociatedTokenAddress } from '@solana/spl-token'
import { pick, flatten, findKey, uniqBy, chunk, get, groupBy, update } from 'lodash';
import { add, isBefore, sub, isAfter, differenceInSeconds } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import Bottleneck from 'bottleneck'
import axios from 'axios';

const supabaseUrl = process.env.DB_URL as string;
const supabaseServiceKey = process.env.DB_SECRET as string;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

export async function addSales({ items }) {
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

export async function updateMint({ mint, metadata }) {
  if (!mint || !metadata) {
    return;
  }
  const { data, error } = await supabase
    .from('nfts')
    .upsert({ mint, metadata })

  if (error) {
    throw new Error('Error updating mint');
  }

  return data;
}

export async function addSale({ sale, metadata }) {
  await updateMint({ mint: sale.mint, metadata })
  const { data, error } = await supabase
    .from('sales')
    .upsert(sale)

  if (error) {
    console.log(error)
    throw new Error('Error updating mints')
  }
}