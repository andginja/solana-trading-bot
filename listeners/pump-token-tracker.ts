import { Connection, PublicKey, ParsedAccountData, LAMPORTS_PER_SOL, AccountInfo } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { logger } from '../helpers';
import { AccountLayout, TOKEN_PROGRAM_ID, MintLayout } from '@solana/spl-token';
import { Metaplex } from '@metaplex-foundation/js';
import { getMint } from '@solana/spl-token';
import { TokenFilters } from './filters';
import BN from 'bn.js';
import { BondingCurveAccount, CreateEvent, PumpFunSDK } from '../src';
import { AnchorProvider } from '@coral-xyz/anchor';
import { struct, u64, u128 } from '@coral-xyz/borsh';
import { PoolInfoLayout, SqrtPriceMath } from '@raydium-io/raydium-sdk';
import { PumpFunScanner } from './pump-transaction-scanner';

interface TokenData {
  mintAddress: string;
  creationTime: number;
  lastUpdateTime: number;
  currentPrice: number | null;
  holders: number;
  whaleTransactions: number;
  whaleTransactionVolume: number;
  buyPressure: number;
  sellPressure: number;
  recentTransactions: Transaction[];
  spamScore: number;
  hasMetadata: boolean;
  isBurned: boolean;
  isRenounced: boolean;
  decimals: number;
  symbol: string;
  name: string;
  marketCap: number | null;
  lastTransactionTime?: number;
  logoURI: string;
  lastTransactionAmount?: number;
  lastTransactionType?: 'buy' | 'sell' | 'transfer';
}

interface Transaction {
  type: 'BUY' | 'SELL';
  amount: number;
  timestamp: number;
  from: string;
  to: string;
}

interface AnalysisResult {
  address: string;
  score: number;
  buyingMomentumScore: number;
  recommendation: 'STRONG BUY' | 'BUY' | 'HOLD' | 'IGNORE';
}

export class PumpFunTokenTracker extends EventEmitter {
  private tokens: Map<string, TokenData> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly TTL_MINUTES = 20;
  private readonly UPDATE_INTERVAL_MS = 60000; // 1 minute
  private readonly WHALE_THRESHOLD_SOL = 500;
  private readonly WHALE_THRESHOLD_TOKEN_VALUE = 10000;
  private readonly SPAM_THRESHOLD = 100; // Transactions per minute
  private readonly MIN_HOLDERS_THRESHOLD = 5;
  private readonly HOLDER_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private tokenAccountCache: Map<string, number> = new Map();
  private lastFetchTime: Map<string, number> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private holderCheckIntervals: Map<string, NodeJS.Timeout> = new Map();
  private tokenTransferSubscriptions: Map<string, number> = new Map();
  private readonly MIN_TRANSACTION_VALUE_SOL = 0.3; // Minimum transaction value in SOL
  private metaplex: Metaplex;
  private pumpFunSDK: PumpFunSDK;
  private transactionScanner;

  constructor(private readonly connection: Connection) {
    super();
    this.metaplex = Metaplex.make(connection);
    const provider = new AnchorProvider(
      this.connection,
      {
        publicKey: PublicKey.default,
        signTransaction: async () => {
          throw new Error('Not implemented');
        },
        signAllTransactions: async () => {
          throw new Error('Not implemented');
        },
      },
      { commitment: this.connection.commitment },
    );
    this.pumpFunSDK = new PumpFunSDK(provider);
    this.transactionScanner = new PumpFunScanner(connection, this.pumpFunSDK);
  }

  async addToken(eventData: CreateEvent) {
    try {
      const mintAddress = eventData.mint;
      const bondingCurveAccount = await this.pumpFunSDK.getBondingCurveAccount(mintAddress);
      if (!bondingCurveAccount) {
        console.warn(`Bonding curve account not found for address ${mintAddress.toBase58()}`);
        return;
      }
      const address = mintAddress.toBase58();
      if (!this.tokens.has(address)) {
        const metadata: TokenMetadata = {
          name: eventData.name,
          symbol: eventData.symbol,
          decimals: 9,
          logoURI: eventData.uri,
        };

        const [holders, price, marketCap] = await Promise.all([
          this.fetchTokenHolders(mintAddress),
          this.fetchTokenPrice(mintAddress, bondingCurveAccount),
          this.fetchMarketCap(bondingCurveAccount),
        ]);

        const tokenInfo = {
          mintAddress: address,
          creationTime: Date.now(),
          lastUpdateTime: Date.now(),
          currentPrice: price * 142.41,
          holders,
          whaleTransactions: 0,
          whaleTransactionVolume: 0,
          buyPressure: 0,
          sellPressure: 0,
          recentTransactions: [],
          spamScore: 0,
          hasMetadata: true,
          isBurned: false,
          isRenounced: false,
          decimals: metadata.decimals,
          symbol: metadata.symbol,
          name: metadata.name,
          logoURI: metadata.logoURI,
          marketCap: marketCap * 132,
        };

        this.tokens.set(address, tokenInfo);

        this.subscribeToTokenTransfers(mintAddress, metadata);
        this.scheduleHolderCheck(address);

        this.emit('tokenAdded', this.tokens.get(address));
      }
    } catch (error) {
      console.error(`Error adding token with address ${eventData.mint.toBase58()}:`, error);
    }
  }

  private scheduleHolderCheck(address: string) {
    const interval = setInterval(async () => {
      const token = this.tokens.get(address);
      if (!token) {
        clearInterval(interval);
        return;
      }

      const holders = await this.fetchTokenHolders(new PublicKey(address));
      token.holders = holders;

      if (holders < this.MIN_HOLDERS_THRESHOLD) {
        this.unsubscribeFromTokenTransfers(new PublicKey(address));
        clearInterval(interval);
        this.holderCheckIntervals.delete(address);
        logger.info(`Unsubscribed from token ${address} due to insufficient holders: ${holders}`);
      }
    }, this.HOLDER_CHECK_INTERVAL_MS);

    this.holderCheckIntervals.set(address, interval);
  }

  private async subscribeToTokenTransfers(mintAddress: PublicKey, metadata: TokenMetadata) {
    this.transactionScanner.subscribeToTokenTransfers(mintAddress, metadata);
  }

  private async processTransfer(
    mintAddress: PublicKey,
    from: PublicKey,
    to: PublicKey,
    amount: bigint,
    transactionType: 'buy' | 'sell' | 'transfer',
    bondingCurveAccount: BondingCurveAccount,
    bondingCurvePDA: PublicKey,
  ) {
    const tokenData = this.tokens.get(mintAddress.toBase58());
    if (!tokenData) {
      console.warn(`Token data not found for address ${mintAddress.toBase58()}`);
      return;
    }

    const [holders, price, marketCap] = await Promise.all([
      this.fetchTokenHolders(mintAddress),
      this.fetchTokenPrice(mintAddress, bondingCurveAccount),
      this.fetchMarketCap(bondingCurveAccount),
    ]);

    const transferAmount = Number(amount / BigInt(Math.pow(10, tokenData.decimals)));
    const transactionValueSOL = transferAmount * price;

    logger.info(`🔔 Transfer detected for token ${tokenData.symbol} (${mintAddress.toBase58()})`);
    logger.info(`📤 From: ${from.toBase58()}`);
    logger.info(`📥 To: ${to.toBase58()}`);
    logger.info(` Bonding Curve: ${bondingCurvePDA.toBase58()}`);
    logger.info(`💰 Amount: ${transferAmount} ${tokenData.symbol}`);
    logger.info(`💎 Value: ${transactionValueSOL} SOL`);
    logger.info(`💎 Token Price: ${price * 138}`);
    logger.info(`💎 Market Cap: ${marketCap * 138}`);
    logger.info(`💎 Holders: ${holders}`);
    logger.info(`💎 Transaction Type: ${transactionType}`);

    if (transactionValueSOL >= this.MIN_TRANSACTION_VALUE_SOL) {
      const [isFromWhale, isToWhale] = await Promise.all([
        this.isWhale(from, transferAmount, tokenData.currentPrice),
        this.isWhale(to, transferAmount, tokenData.currentPrice),
      ]);

      logger.info(`  Is from whale: ${isFromWhale}`);
      logger.info(`  Is to whale: ${isToWhale}`);

      // Update token data
      tokenData.lastUpdateTime = Date.now();
      tokenData.lastTransactionTime = Date.now();
      tokenData.lastTransactionAmount = transferAmount;
      tokenData.lastTransactionType = transactionType;
      tokenData.currentPrice = price;
      tokenData.marketCap = marketCap * 138;
      tokenData.holders = holders;

      if (transactionType === 'buy') {
        tokenData.buyPressure += transferAmount;
        logger.info(`  Buy pressure increased to: ${tokenData.buyPressure}`);
      } else if (transactionType === 'sell') {
        tokenData.sellPressure += transferAmount;
        logger.info(`  Sell pressure increased to: ${tokenData.sellPressure}`);
      }

      if (isFromWhale || isToWhale) {
        tokenData.whaleTransactions++;
        tokenData.whaleTransactionVolume += transferAmount;
        logger.info(`  Whale transaction detected`);
        logger.info(`  Total whale transactions: ${tokenData.whaleTransactions}`);
        logger.info(`  Total whale transaction volume: ${tokenData.whaleTransactionVolume} ${tokenData.symbol}`);
      }

      // Add to recent transactions
      tokenData.recentTransactions.push({
        type: transactionType.toUpperCase() as 'BUY' | 'SELL',
        amount: transferAmount,
        timestamp: Date.now(),
        from: from.toBase58(),
        to: to.toBase58(),
      });

      // Keep only the last 100 transactions
      if (tokenData.recentTransactions.length > 100) {
        tokenData.recentTransactions = tokenData.recentTransactions.slice(-100);
      }

      // Update spam score
      this.updateSpamScore(tokenData);
      logger.info(`  Updated spam score: ${tokenData.spamScore}`);

      // Emit whale alert if applicable
      if (isFromWhale || isToWhale) {
        this.emit('whaleAlert', {
          tokenSymbol: tokenData.symbol,
          transferType: transactionType,
          amount: transferAmount,
          from: from.toBase58(),
          to: to.toBase58(),
          transactionValueSOL,
        });
        logger.info(`  Whale alert emitted`);
      }

      // Update token data in the map
      this.tokens.set(mintAddress.toBase58(), tokenData);

      // Emit token updated event
      this.emit('tokenUpdated', tokenData);
      logger.info(`  Token data updated and event emitted`);
    } else {
      logger.info(`  Transaction value below minimum threshold (${this.MIN_TRANSACTION_VALUE_SOL} SOL). Ignoring.`);
    }
  }
  private scheduleTokenDataUpdate(mintAddress: PublicKey) {
    setTimeout(async () => {
      const tokenData = this.tokens.get(mintAddress.toBase58());
      if (!tokenData) return;

      try {
        const [supply, holderCount] = await Promise.all([
          this.connection.getTokenSupply(mintAddress),
          this.fetchTokenHolders(mintAddress),
        ]);

        if (supply.value.uiAmount !== null) {
          tokenData.marketCap = supply.value.uiAmount * (tokenData.currentPrice || 0);
        } else {
          tokenData.marketCap = 0;
        }
        tokenData.holders = holderCount;

        this.tokens.set(mintAddress.toBase58(), tokenData);
        this.emit('tokenUpdated', tokenData);
      } catch (error) {
        console.error(`Error updating token data for ${mintAddress.toBase58()}:`, error);
      }
    }, 5000); // Schedule the update 5 seconds after the transfer
  }

  private unsubscribeFromTokenTransfers(mintAddress: PublicKey) {
    const subscriptionId = this.tokenTransferSubscriptions.get(mintAddress.toBase58());
    if (subscriptionId !== undefined) {
      this.connection.removeOnLogsListener(subscriptionId);
      this.tokenTransferSubscriptions.delete(mintAddress.toBase58());
      console.log(`Unsubscribed from token transfers for ${mintAddress.toBase58()}`);
    } else {
      console.warn(`No subscription found for token ${mintAddress.toBase58()}`);
    }
  }

  private async isWhale(address: PublicKey, transferAmount: number, tokenPrice: number | null): Promise<boolean> {
    const solBalance = await this.getCachedBalance(address);
    const tokenValue = transferAmount * (tokenPrice || 0);
    const isWhale = solBalance >= this.WHALE_THRESHOLD_SOL || tokenValue >= this.WHALE_THRESHOLD_TOKEN_VALUE;

    logger.info(`Whale check for address ${address.toBase58()}`);
    logger.info(`  SOL balance: ${solBalance}`);
    logger.info(`  Token value: ${tokenValue}`);
    logger.info(`  Is whale: ${isWhale}`);

    return isWhale;
  }

  private async getCachedBalance(address: PublicKey): Promise<number> {
    const now = Date.now();
    const addressStr = address.toBase58();
    const lastFetch = this.lastFetchTime.get(addressStr) || 0;

    if (now - lastFetch > this.CACHE_TTL_MS) {
      const balances = await this.batchFetchBalances([address]);
      const balance = balances.get(addressStr) || 0;
      this.tokenAccountCache.set(addressStr, balance);
      this.lastFetchTime.set(addressStr, now);
    }

    return this.tokenAccountCache.get(addressStr) || 0;
  }

  private async batchFetchBalances(addresses: PublicKey[]): Promise<Map<string, number>> {
    const balances = await this.connection.getMultipleAccountsInfo(addresses);
    return new Map(
      balances.map((account, index) => [
        addresses[index].toBase58(),
        account ? account.lamports / LAMPORTS_PER_SOL : 0,
      ]),
    );
  }

  private updateSpamScore(tokenData: TokenData) {
    const now = Date.now();
    const recentTransactions = tokenData.recentTransactions.filter((tx) => now - tx.timestamp <= 60000);
    tokenData.spamScore = recentTransactions.length;
  }

  startTracking() {
    this.updateInterval = setInterval(() => {
      const now = Date.now();
      this.tokens.forEach((token, address) => {
        if ((now - token.creationTime) / 60000 > this.TTL_MINUTES) {
          this.tokens.delete(address);
          logger.info(`Removed expired token: ${address}`);
        } else if (token.spamScore < this.SPAM_THRESHOLD) {
          // this.updateTokenData(new PublicKey(address));
        } else {
        }
      });
    }, this.UPDATE_INTERVAL_MS);
  }

  stopTracking() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.holderCheckIntervals.forEach((interval) => clearInterval(interval));
    this.holderCheckIntervals.clear();

    // Unsubscribe from all token transfer subscriptions
    this.tokenTransferSubscriptions.forEach((_, address) => {
      this.unsubscribeFromTokenTransfers(new PublicKey(address));
    });
  }

  analyzeToken(address: string): AnalysisResult | null {
    const token = this.tokens.get(address);
    if (!token) return null;

    const buyingMomentumScore = this.calculateBuyingMomentumScore(token);
    const score = buyingMomentumScore / 2;

    if (score < 50 || token.spamScore >= this.SPAM_THRESHOLD) {
      return null;
    }

    return {
      address: token.mintAddress,
      score,
      buyingMomentumScore,
      recommendation: this.getRecommendation(score),
    };
  }

  private calculateBuyingMomentumScore(token: TokenData): number {
    const buyPressureRatio = token.buyPressure / (token.buyPressure + token.sellPressure);
    const recentBuys = token.recentTransactions.filter((tx) => tx.type === 'BUY').length;
    const buyRatio = recentBuys / token.recentTransactions.length;
    return Math.min(100, (buyPressureRatio + buyRatio) * 50);
  }

  private getRecommendation(score: number): 'STRONG BUY' | 'BUY' | 'HOLD' | 'IGNORE' {
    if (score >= 90) return 'STRONG BUY';
    if (score >= 75) return 'BUY';
    if (score >= 60) return 'HOLD';
    return 'IGNORE';
  }
  private convertBigIntToSOL(bigintValue: bigint): number {
    const SOL_DECIMALS = 9;
    const divisor = BigInt(10 ** SOL_DECIMALS);

    // Convert to a string first to avoid potential precision loss
    const wholePart = (bigintValue / divisor).toString();
    const fractionalPart = (bigintValue % divisor).toString().padStart(SOL_DECIMALS, '0');

    // Combine whole and fractional parts
    const solValueString = `${wholePart}.${fractionalPart}`;

    // Parse as a float and round to a reasonable number of decimal places (e.g., 6)
    return parseFloat(parseFloat(solValueString).toFixed(6));
  }

  private async fetchTokenPrice(address: PublicKey, bondingCurveAccount: BondingCurveAccount): Promise<number> {
    try {
      const priceInSOL = this.convertBigIntToSOL(bondingCurveAccount.getUniqueTokenPrice());
      return priceInSOL;
    } catch (error) {
      console.error(`Error fetching token price for ${address}:`, error);
      return 0;
    }
  }

  private async fetchMarketCap(bondingCurveAccount: BondingCurveAccount): Promise<number> {
    return this.convertBigIntToSOL(bondingCurveAccount.getMarketCapSOL());
  }

  private async fetchTokenHolders(mintAddress: PublicKey): Promise<number> {
    const tokenAccounts = await this.connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mintAddress.toBase58() } }],
    });

    const holders = tokenAccounts.filter((account) => {
      const parsedData = (account.account.data as ParsedAccountData).parsed;
      return parsedData.info.tokenAmount.uiAmount > 0;
    }).length;

    return holders;
  }
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
}
