import { AccountInfo, Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import { BondingCurveAccount } from '../src/bondingCurveAccount'; // Add this import

import { PumpFunSDK } from '../src/pumpfun'; // Adjust the import path as needed
import { TokenMetadata } from './pump-token-tracker';

export class PumpFunScanner {
  private connection: Connection;
  private tokenTransferSubscriptions: Map<string, number> = new Map();
  private sdk: PumpFunSDK;
  private instructionCoder: BorshInstructionCoder;

  constructor(connection: Connection, sdk: PumpFunSDK) {
    this.connection = connection;
    this.sdk = sdk;
    this.instructionCoder = new BorshInstructionCoder(this.sdk.program.idl);
  }

  public async subscribeToTokenTransfers(mintAddress: PublicKey, metadata: TokenMetadata) {
    const filters = [
      {
        memcmp: {
          offset: 0,
          bytes: mintAddress.toBase58(),
        },
      },
      { dataSize: 165 }, // Adjust the size based on your instruction size (example)
    ];

    const subscriptionId = this.connection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (accountInfo) => {
        await this.handleAccountChange(accountInfo, mintAddress, metadata);
      },
      'finalized',
      filters,
    );

    console.info(`Subscribed to token transfers for ${metadata.name} ${metadata.symbol} (${mintAddress.toBase58()})`);
    this.tokenTransferSubscriptions.set(mintAddress.toBase58(), subscriptionId);
  }

  private async handleAccountChange(
    accountInfo: {
      accountId: PublicKey;
      accountInfo: AccountInfo<Buffer>;
    },
    mintAddress: PublicKey,
    metadata: TokenMetadata,
  ) {
    try {
      const transactionSignatures = await this.connection.getConfirmedSignaturesForAddress2(accountInfo.accountId, {
        limit: 1,
      });

      if (transactionSignatures.length > 0) {
        const signature = transactionSignatures[0].signature;
        const transactionDetails = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (transactionDetails) {
          const result = await this.processTransactionDetails(
            transactionDetails,
            mintAddress,
            signature,
            mintAddress,
            metadata,
          );
          if (result) {
            // Token analysis logic
            if (result.amountSOL > 1) {
              const userAccountInfo = await this.connection.getAccountInfo(new PublicKey(result.user));
              const userSolBalance = userAccountInfo?.lamports ? userAccountInfo.lamports / 1e9 : 0;

              console.log('USER SOL BALANCE', userSolBalance);
              console.log(`User ${result.user} has ${userSolBalance} SOL`);
              if (userSolBalance > 100) {
                console.log(`Whale detected: User ${result.user} has ${userSolBalance} SOL`);
                console.log(result);
              } else {
                console.log(`User ${result.user} has ${userSolBalance} SOL`);
              }

              const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(result.user), {
                programId: TOKEN_PROGRAM_ID,
              });

              let totalTokenBalance = 0;
              tokenAccounts.value.forEach((account) => {
                const tokenAmount = account.account.data.parsed.info.tokenAmount.uiAmount;
                totalTokenBalance += tokenAmount;
              });

              console.log('TOKEN BALANCE', totalTokenBalance);
              if (totalTokenBalance > 1000) {
                console.log(`Whale detected: User ${result.user} has ${totalTokenBalance} tokens`);
                console.log(result);
              } else {
                console.log(`User ${result.user} has ${totalTokenBalance} tokens`);
              }

              // Fresh wallet logic
              const block = await this.connection.getBlock(transactionSignatures[0].slot, {
                maxSupportedTransactionVersion: 0,
              });
              const creationTime = block?.blockTime ? block.blockTime : 0;
              const currentTime = Math.floor(Date.now() / 1000);
              const walletAge = currentTime - creationTime;
              console.log(`Wallet age: ${walletAge} seconds`);
              if (walletAge < 2 * 24 * 60 * 60) {
                console.log(
                  `Fresh wallet detected: User ${result.user} created ${walletAge} seconds ago for token ${result.name} ${result.symbol} (${result.mintAddress})`,
                );
                console.log(result);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error processing transfer for ${mintAddress.toBase58()}:`, error);
    }
  }

  private async processTransactionDetails(
    transactionDetails: ParsedTransactionWithMeta,
    mintAddress: PublicKey,
    signature: string,
    tokenMint: PublicKey,
    metadata: TokenMetadata,
  ): Promise<TransferDetails | null> {
    const { transaction, meta } = transactionDetails;
    const instructions = transaction.message.instructions.filter(
      (instr: any) => instr.programId.toBase58() === this.sdk.program.programId.toBase58(),
    );

    for (const instr of instructions) {
      if ('parsed' in instr) {
        continue;
      }

      const decodedInstruction = this.instructionCoder.decode(Buffer.from(bs58.decode(instr.data)));

      if (decodedInstruction) {
        const bondingCurve = new PublicKey(instr.accounts[3]);
        const user = new PublicKey(instr.accounts[6]);

        let mainTokenAmount = 0;
        let mainSolAmount = 0;

        if (meta && meta.postTokenBalances && meta.preTokenBalances && meta.postBalances && meta.preBalances) {
          const preTokenBalances = new Map(meta.preTokenBalances.map((b: any) => [b.accountIndex, b]));
          const preSolBalances = new Map(meta.preBalances.map((balance, index) => [index, balance]));

          // Find the main token transfer
          meta.postTokenBalances.forEach((postBalance) => {
            const preBalance = preTokenBalances.get(postBalance.accountIndex);
            if (preBalance && preBalance.mint === mintAddress.toBase58()) {
              const tokenChange =
                Number(BigInt(postBalance.uiTokenAmount.amount) - BigInt(preBalance.uiTokenAmount.amount)) / 1e6;
              if (Math.abs(tokenChange) > Math.abs(mainTokenAmount)) {
                mainTokenAmount = tokenChange;
              }
            }
          });

          // Find the main SOL transfer and calculate fees
          meta.postBalances.forEach((postBalance: number, index: number) => {
            const preBalance = preSolBalances.get(index);
            if (preBalance !== undefined) {
              const change = (postBalance - preBalance) / 1e9;
              if (change !== 0) {
                if (Math.abs(change) > Math.abs(mainSolAmount)) {
                  if (mainSolAmount !== 0) {
                  }
                  mainSolAmount = change;
                } else {
                }
              }
            }
          });
        }

        // Adjust signs based on transaction type
        if (decodedInstruction.name === 'sell') {
          mainTokenAmount = -Math.abs(mainTokenAmount);
          mainSolAmount = Math.abs(mainSolAmount);
        } else {
          // buy
          mainTokenAmount = Math.abs(mainTokenAmount);
          mainSolAmount = -Math.abs(mainSolAmount);
        }

        // Fetch the bonding curve account data
        const bondingCurveAccount = await this.sdk.getBondingCurveAccount(mintAddress);
        if (!bondingCurveAccount) {
          console.warn(`Bonding curve account not found for address ${mintAddress.toBase58()}`);
          return null;
        }

        const currentMarketCap = Number(bondingCurveAccount.getMarketCapSOL()) / 1e9;
        const finalMarketCap = Number(bondingCurveAccount.getFinalMarketCapSOL(0n)) / 1e9;
        // Calculate percentage filled
        const percentageFilled = `${((currentMarketCap / finalMarketCap) * 100).toFixed(2)}%`;

        return {
          symbol: metadata.symbol,
          name: metadata.name,
          image: metadata.logoURI,
          decimals: metadata.decimals,
          transactionType: decodedInstruction.name,
          amountSOL: Math.abs(mainSolAmount),
          amountToken: Math.abs(mainTokenAmount),
          user: user.toBase58(),
          bondCurveAddress: bondingCurve.toBase58(),
          percentageFilled,
          currentMarketCap: currentMarketCap * 132,
          finalMarketCap: finalMarketCap * 132,
          mintAddress: tokenMint.toBase58(),
          signature: signature,
        };
      }
    }

    return null;
  }
}

export interface TransferDetails {
  symbol: string;
  name: string;
  image: string;
  decimals: number;
  transactionType: string;
  amountSOL: number;
  amountToken: number;
  user: string;
  bondCurveAddress: string;
  percentageFilled: string;
  currentMarketCap: number;
  mintAddress: string;
  signature: string;
  finalMarketCap: number;
}
