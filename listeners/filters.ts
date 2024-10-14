import { Connection, PublicKey } from '@solana/web3.js';
import { MintLayout } from '@solana/spl-token';
import { logger } from '../helpers';

export interface FilterResult {
  ok: boolean;
  message?: string;
}

export class TokenFilters {
  constructor(private readonly connection: Connection) {}

  async isBurned(mintAddress: PublicKey): Promise<FilterResult> {
    try {
      const supply = await this.connection.getTokenSupply(mintAddress);
      const burned = supply.value.uiAmount === 0;
      return {
        ok: burned,
        message: burned ? undefined : 'LP not burned',
      };
    } catch (error) {
      logger.error({ mint: mintAddress.toBase58() }, `Failed to check if LP is burned`);
      return { ok: false, message: 'Failed to check if LP is burned' };
    }
  }

  async isRenounced(mintAddress: PublicKey): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(mintAddress);
      if (!accountInfo?.data) {
        return { ok: false, message: 'Failed to fetch mint account data' };
      }

      const mintInfo = MintLayout.decode(accountInfo.data);
      const renounced = mintInfo.mintAuthorityOption === 0;
      return {
        ok: renounced,
        message: renounced ? undefined : 'Mint authority not renounced',
      };
    } catch (error) {
      logger.error({ mint: mintAddress.toBase58() }, `Failed to check if mint is renounced`);
      return { ok: false, message: 'Failed to check if mint is renounced' };
    }
  }
}
