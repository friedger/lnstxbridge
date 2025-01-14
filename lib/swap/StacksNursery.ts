import { Op } from 'sequelize';
import { EventEmitter } from 'events';
import { BigNumber, ContractTransaction } from 'ethers';
import Errors from './Errors';
import Logger from '../Logger';
import Swap from '../db/models/Swap';
import Wallet from '../wallet/Wallet';
import { etherDecimals } from '../consts/Consts';
import SwapRepository from '../db/SwapRepository';
import ReverseSwap from '../db/models/ReverseSwap';
import WalletManager from '../wallet/WalletManager';
import ReverseSwapRepository from '../db/ReverseSwapRepository';
import { CurrencyType, SwapUpdateEvent } from '../consts/Enums';
// import EthereumManager from '../wallet/ethereum/EthereumManager';
// import RskManager from '../wallet/rsk/RskManager';
import { ERC20SwapValues, EtherSwapValues } from '../consts/Types';
import { getChainCurrency, getHexString, splitPairId, stringify } from '../Utils';
import ERC20WalletProvider from '../wallet/providers/ERC20WalletProvider';
import StacksManager from 'lib/wallet/stacks/StacksManager';
import { TxBroadcastResult } from '@stacks/transactions';
import { getTx } from '../wallet/stacks/StacksUtils';
import type { Transaction } from '@stacks/stacks-blockchain-api-types';

interface StacksNursery {
  // EtherSwap
  on(event: 'eth.lockup', listener: (swap: Swap, transactionHash: string, etherSwapValues: EtherSwapValues) => void): this;
  emit(event: 'eth.lockup', swap: Swap, transactionHash: string, etherSwapValues: EtherSwapValues): boolean;

  // ERC20Swap
  on(event: 'erc20.lockup', listener: (swap: Swap, transactionHash: string, erc20SwapValues: ERC20SwapValues) => void): this;
  emit(event: 'erc20.lockup', swap: Swap, transactionHash: string, erc20SwapValues: ERC20SwapValues): boolean;

  // Events used for both contracts
  on(event: 'swap.expired', listener: (swap: Swap, isEtherSwap: boolean) => void): this;
  emit(event: 'swap.expired', swap: Swap, isEtherSwap: boolean);

  on(event: 'lockup.failed', listener: (swap: Swap, reason: string) => void): this;
  emit(event: 'lockup.failed', swap: Swap, reason: string): boolean;

  on(event: 'reverseSwap.expired', listener: (reverseSwap: ReverseSwap, isEtherSwap: boolean) => void): this;
  emit(event: 'reverseSwap.expired', reverseSwap: ReverseSwap, isEtherSwap: boolean);

  on(event: 'lockup.failedToSend', listener: (reverseSwap: ReverseSwap, reason: string) => void): this;
  emit(event: 'lockup.failedToSend', reverseSwap: ReverseSwap, reason: string): boolean;

  on(event: 'lockup.confirmed', listener: (reverseSwap: ReverseSwap, transactionHash: string) => void): this;
  emit(event: 'lockup.confirmed', reverseSwap: ReverseSwap, transactionHash: string): boolean;

  on(event: 'claim', listener: (reverseSwap: ReverseSwap, preimage: Buffer) => void): this;
  emit(event: 'claim', reverseSwap: ReverseSwap, preimage: Buffer): boolean;

  // on(event: 'swap.update', listener: (id: string, message: SwapUpdate) => void): this;
  // emit(event: 'swap.update', id: string, message: SwapUpdate): boolean;

  on(event: 'tx.sent', listener: (reverseSwap: ReverseSwap, transactionHash: string) => void): this;
  emit(event: 'tx.sent', reverseSwap: ReverseSwap, transactionHash: string): boolean;
}

class StacksNursery extends EventEmitter {
  private stacksManager: StacksManager;

  constructor(
    private logger: Logger,
    private walletManager: WalletManager,
    private swapRepository: SwapRepository,
    private reverseSwapRepository: ReverseSwapRepository,
  ) {
    super();

    // this.ethereumManager = walletManager.ethereumManager!;
    // this.rskManager = walletManager.rskManager!;
    this.stacksManager = walletManager.stacksManager!;

    this.listenBlocks();

    this.logger.error("StacksNursery listeners are starting...");
    this.listenEtherSwap();
    this.listenERC20Swap();
  }

  public init = async (): Promise<void> => {
    // Fetch all Reverse Swaps with a pending lockup transaction
    const mempoolReverseSwaps = await this.reverseSwapRepository.getReverseSwaps({
      status: {
        [Op.eq]: SwapUpdateEvent.TransactionMempool,
      },
    });

    // remove later
    // const allReverseSwaps = await ReverseSwap.findAll();
    // this is tested and all reverswaps go into invoice.settled now, yay!
    // console.log("allReverseSwaps: ", allReverseSwaps);


    for (const mempoolReverseSwap of mempoolReverseSwaps) {
      // const { base, quote } = splitPairId(mempoolReverseSwap.pair);
      // const chainCurrency = getChainCurrency(base, quote, mempoolReverseSwap.orderSide, true);

      // // Skip all Reverse Swaps that didn't send coins on the Stacks chain
      // if (this.getEthereumWallet(chainCurrency) === undefined) {
      //   this.logger.error("StacksNursery.93 Skip all Reverse Swaps that didn't send coins on the Stacks chain");
      //   continue;
      // }

      try {
        this.logger.error("stacksnurseryr.98 mempoolReverseSwap " + mempoolReverseSwap.transactionId)
        // const transaction = await this.stacksManager.provider.getTransaction(mempoolReverseSwap.transactionId!);
        const transaction = await getTx(mempoolReverseSwap.transactionId!)
        this.logger.debug(`Found pending Stx lockup transaction of Reverse Swap ${mempoolReverseSwap.id}: ${mempoolReverseSwap.transactionId}, ${transaction}`);
        // this.listenContractTransaction(mempoolReverseSwap, transaction);
        // this.listenStacksContractTransaction(mempoolReverseSwap, transaction);
        this.checkStacksTransaction(mempoolReverseSwap, transaction);
      } catch (error) {
        this.logger.error(`stacksnursery.106 error ${error}`);
        // TODO: retry finding that transaction
        // If the provider can't find the transaction, it is not on the chain
      }
    }
  }

  public listenContractTransaction = (reverseSwap: ReverseSwap, transaction: ContractTransaction): void => {
    transaction.wait(1).then(async () => {
      this.emit(
        'lockup.confirmed',
        await this.reverseSwapRepository.setReverseSwapStatus(reverseSwap, SwapUpdateEvent.TransactionConfirmed),
        transaction.hash,
      );
    }).catch(async (reason) => {
      this.emit(
        'lockup.failedToSend',
        await this.reverseSwapRepository.setReverseSwapStatus(reverseSwap, SwapUpdateEvent.TransactionFailed),
        reason,
      );
    });
  }

  public listenStacksContractTransaction = async (reverseSwap: ReverseSwap, transaction: TxBroadcastResult): Promise<void> => {
    // transaction.wait(1).then(async () => {
      this.logger.error("stacksnursery.120 listenStacksContractTransaction tx: "+ JSON.stringify(transaction))
      if(transaction.error) {
        this.emit(
          'lockup.failedToSend',
          await this.reverseSwapRepository.setReverseSwapStatus(reverseSwap, SwapUpdateEvent.TransactionFailed),
          transaction.error,
        );
      } else {
        // TODO: this causes transaction.confirmed immediately - need to add another state mempool here
        // no this is lockup.confirmed not transaction.confirmed
        this.emit(
          'lockup.confirmed',
          await this.reverseSwapRepository.setReverseSwapStatus(reverseSwap, SwapUpdateEvent.TransactionConfirmed),
          transaction.txid,
        );
      }
    // }).catch(async (reason) => {

    // });
  }

  public checkStacksTransaction = async (reverseSwap: ReverseSwap, transaction: Transaction): Promise<void> => {
    // transaction.wait(1).then(async () => {
      this.logger.error("stacksnursery.154 checkStacksTransaction tx: "+ JSON.stringify(transaction) + ", " + stringify(reverseSwap))
      if(transaction.tx_status !== "success") {
        this.emit(
          'lockup.failedToSend',
          await this.reverseSwapRepository.setReverseSwapStatus(reverseSwap, SwapUpdateEvent.TransactionFailed),
          transaction.tx_status,
        );
      } else {
        this.emit(
          'lockup.confirmed',
          await this.reverseSwapRepository.setReverseSwapStatus(reverseSwap, SwapUpdateEvent.TransactionConfirmed),
          transaction.tx_id,
        );
      }
    // }).catch(async (reason) => {

    // });
  }

  private listenEtherSwap = () => {
    // this.logger.debug("StacksNursery.118 listenEtherSwap enter")
    this.stacksManager.contractEventHandler.on('eth.lockup', async (
      transactionHash,
      etherSwapValues,
    ) => {
      this.logger.verbose("StacksNursery listenEtherSwap eth.lockup enter " + getHexString(etherSwapValues.preimageHash));
      let swap = await this.swapRepository.getSwap({
        preimageHash: {
          [Op.eq]: getHexString(etherSwapValues.preimageHash),
        },
        status: {
          [Op.or]: [
            SwapUpdateEvent.SwapCreated,
            SwapUpdateEvent.InvoiceSet,
          ],
        },
      });

      if (!swap) {
        this.logger.error("StacksNursery.137 swap not found! " + transactionHash);

        // check if this is our own lockup that user needs to claim from GUI so just set tx to confirmed and exit
        let reverseSwap = await this.reverseSwapRepository.getReverseSwap({
          preimageHash: {
            [Op.eq]: getHexString(etherSwapValues.preimageHash),
          },
          status: {
            [Op.or]: [
              SwapUpdateEvent.TransactionMempool,
            ],
          },
        });
        if(reverseSwap){
          this.logger.error("StacksNursery.209 reverseswap self lockup found " + reverseSwap.transactionId!);
          try {

            // exact same thing as in mempoolreverseswap
            // const transaction = await getTx(reverseSwap.transactionId!)
            // this.logger.debug(`stacksnursery.217 Reverse Swap TX ${reverseSwap.id}: ${reverseSwap.transactionId}`);
            // this.logger.debug(`stacksnursery.218 tx: ` + stringify(reverseSwap));
            // this.checkStacksTransaction(reverseSwap, transaction);

            const transaction: Transaction = await getTx(reverseSwap!.transactionId!)
            this.logger.debug(`Found pending Stx lockup transaction of Reverse Swap ${reverseSwap.id}: ${reverseSwap.transactionId}, ${transaction.tx_id}`);
            // this.logger.debug(`stacksnursery.223 tx: ` + stringify(reverseSwap));
            await this.reverseSwapRepository.setReverseSwapStatus(reverseSwap, SwapUpdateEvent.TransactionConfirmed);

            // this.stacksManager.contractEventHandler.emit('swap.update', reverseSwap.id, {
            //   status: SwapUpdateEvent.TransactionConfirmed,
            //   transaction: {
            //     id: transaction.tx_id,
            //     // hex: transaction.block_hash,
            //   },
            // });

            // this.emit('swap.update', reverseSwap.id, {
            //   status: SwapUpdateEvent.TransactionConfirmed,
            //   transaction: {
            //     // id: transaction,
            //     id: transaction.tx_id,
            //     hex: transaction.block_hash,
            //   },
            // });

            this.emit('tx.sent', reverseSwap, transaction.tx_id);
            // {
            //   status: SwapUpdateEvent.TransactionConfirmed,
            //   transaction: {
            //     id: transaction.tx_id,
            //     // hex: transaction.block_hash,
            //   },
            // });

            // this.emit(
            //   'lockup.confirmed',
            //   await this.reverseSwapRepository.setReverseSwapStatus(reverseswap, SwapUpdateEvent.TransactionConfirmed),
            //   transaction.tx_id,
            // );
            // this.logger.debug(`stacksNursery.244 after swap.update ${SwapUpdateEvent.TransactionConfirmed}`);
            // let reverseSwap2 = await this.reverseSwapRepository.getReverseSwap({
            //   preimageHash: {
            //     [Op.eq]: getHexString(etherSwapValues.preimageHash),
            //   },
            //   // status: {
            //   //   [Op.or]: [
            //   //     SwapUpdateEvent.TransactionMempool,
            //   //   ],
            //   // },
            // });
            // this.logger.debug(`stacksnursery.250 after setReverseSwapStatus: ` + stringify(reverseSwap2));
          } catch (error) {
            this.logger.error(`stacksnursery.215 error ${error}`);
          }
        }

        return;
      }

      const { base, quote } = splitPairId(swap.pair);
      const chainCurrency = getChainCurrency(base, quote, swap.orderSide, false);

      if (chainCurrency !== 'STX') {
        return;
      }

      this.logger.debug(`Found lockup in stxswap contract for Swap ${swap.id}: ${transactionHash}`);

      // 0x000000000000000000000000001e708f
      // *100 + 100 because stx is 10^6 while boltz is 10^8
      let swapamount = (parseInt(etherSwapValues.amount + "",16) * 100) + 100
      this.logger.verbose("stacksnursery.150 etherSwapValues.amount, swapamount, transactionHash " + etherSwapValues.amount + ", " + swapamount + ", " + transactionHash)
      swap = await this.swapRepository.setLockupTransaction(
        swap,
        transactionHash,
        // etherSwapValues.amount.div(etherDecimals).toNumber(),
        swapamount,
        true,
      );

      this.logger.error("StacksNursery listenetherswap claimAddress, this.stacksmanageraddress: " + etherSwapValues.claimAddress + ", " + this.stacksManager.address + ", " + JSON.stringify(etherSwapValues));
      // skip claimaddress check because Stacks claim address are dummy buffers...
      // if (etherSwapValues.claimAddress !== this.stacksManager.address) {
      //   this.emit(
      //     'lockup.failed',
      //     swap,
      //     Errors.INVALID_CLAIM_ADDRESS(etherSwapValues.claimAddress, this.stacksManager.address).message,
      //   );
      //   return;
      // }

      let swaptimelock = parseInt(etherSwapValues.timelock + "",16) 
      this.logger.verbose("etherSwapValues.timelock, swap.timeoutBlockHeight " +etherSwapValues.timelock + ", " + swap.timeoutBlockHeight)
      // etherSwapValues.timelock
      if (swaptimelock !== swap.timeoutBlockHeight) {
        this.emit(
          'lockup.failed',
          swap,
          Errors.INVALID_TIMELOCK(etherSwapValues.timelock, swap.timeoutBlockHeight).message,
        );
        return;
      }
      
      if (swap.expectedAmount) {
        const expectedAmount = BigNumber.from(swap.expectedAmount).mul(etherDecimals);

        // 1995138440000000000,
        const bigswapamount = BigNumber.from(swapamount).mul(etherDecimals);
        this.logger.verbose("swap.expectedAmount, expectedAmount , etherSwapValues.amount" +swap.expectedAmount+ ", " + expectedAmount + ", " + etherSwapValues.amount)
        // etherSwapValues.amount
        if (expectedAmount.gt(bigswapamount)) {
          this.emit(
            'lockup.failed',
            swap,
            Errors.INSUFFICIENT_AMOUNT(swapamount, swap.expectedAmount).message,
          );
          return;
        }
      }

      this.emit('eth.lockup', swap, transactionHash, etherSwapValues);
    });

    this.stacksManager.contractEventHandler.on('eth.claim', async (transactionHash, preimageHash, preimage) => {
      this.logger.debug("stacksnursery.228 on 'eth.claim " + transactionHash+ ", " + getHexString(preimageHash));

      // const allReverseSwaps = await ReverseSwap.findAll();
      // console.log("allReverseSwaps: ", allReverseSwaps);

      const reverseSwap = await this.reverseSwapRepository.getReverseSwap({
        preimageHash: {
          [Op.eq]: getHexString(preimageHash),
        },
        status: {
          [Op.not]: SwapUpdateEvent.InvoiceSettled,
        },
      });

      if (!reverseSwap) {
        this.logger.error("stacksnursery.239 reverseswap not found")
        return;
      }

      this.logger.debug(`Found claim in EtherSwap contract for Reverse Swap ${reverseSwap.id}: ${transactionHash}`);

      this.emit('claim', reverseSwap, preimage);
    });
  }

  private listenERC20Swap = () => {
    this.stacksManager.contractEventHandler.on('erc20.lockup', async (
      transactionHash,
      erc20SwapValues,
    ) => {
      let swap = await this.swapRepository.getSwap({
        preimageHash: {
          [Op.eq]: getHexString(erc20SwapValues.preimageHash),
        },
        status: {
          [Op.or]: [
            SwapUpdateEvent.SwapCreated,
            SwapUpdateEvent.InvoiceSet,
          ],
        },
      });

      if (!swap) {
        return;
      }

      const { base, quote } = splitPairId(swap.pair);
      const chainCurrency = getChainCurrency(base, quote, swap.orderSide, false);

      const wallet = this.walletManager.wallets.get(chainCurrency);

      if (wallet === undefined || wallet.type !== CurrencyType.ERC20) {
        return;
      }

      const erc20Wallet = wallet.walletProvider as ERC20WalletProvider;

      this.logger.debug(`Found lockup in ERC20Swap contract for Swap ${swap.id}: ${transactionHash}`);

      swap = await this.swapRepository.setLockupTransaction(
        swap,
        transactionHash,
        erc20Wallet.normalizeTokenAmount(erc20SwapValues.amount),
        true,
      );

      if (erc20SwapValues.claimAddress !== this.stacksManager.address) {
        this.emit(
          'lockup.failed',
          swap,
          Errors.INVALID_CLAIM_ADDRESS(erc20SwapValues.claimAddress, this.stacksManager.address).message,
        );
        return;
      }

      if (erc20SwapValues.tokenAddress !== erc20Wallet.getTokenAddress()) {
        this.emit(
          'lockup.failed',
          swap,
          Errors.INVALID_TOKEN_LOCKED(erc20SwapValues.tokenAddress, this.stacksManager.address).message,
        );
        return;
      }

      if (erc20SwapValues.timelock !== swap.timeoutBlockHeight) {
        this.emit(
          'lockup.failed',
          swap,
          Errors.INVALID_TIMELOCK(erc20SwapValues.timelock, swap.timeoutBlockHeight).message,
        );
        return;
      }

      if (swap.expectedAmount) {
        if (erc20Wallet.formatTokenAmount(swap.expectedAmount).gt(erc20SwapValues.amount)) {
          this.emit(
            'lockup.failed',
            swap,
            Errors.INSUFFICIENT_AMOUNT(erc20Wallet.normalizeTokenAmount(erc20SwapValues.amount), swap.expectedAmount).message,
          );
          return;
        }
      }

      this.emit('erc20.lockup', swap, transactionHash, erc20SwapValues);
    });

    this.stacksManager.contractEventHandler.on('erc20.claim', async (transactionHash, preimageHash, preimage) => {
      const reverseSwap = await this.reverseSwapRepository.getReverseSwap({
        preimageHash: {
          [Op.eq]: getHexString(preimageHash),
        },
        status: {
          [Op.not]: SwapUpdateEvent.InvoiceSettled,
        },
      });

      if (!reverseSwap) {
        return;
      }

      this.logger.debug(`Found claim in ERC20Swap contract for Reverse Swap ${reverseSwap.id}: ${transactionHash}`);

      this.emit('claim', reverseSwap, preimage);
    });
  }

  private listenBlocks = () => {
    this.stacksManager.provider.on('block', async (height) => {
      // this.logger.error("RskNursery on block: " + height.toString());
      await Promise.all([
        this.checkExpiredSwaps(height),
        this.checkExpiredReverseSwaps(height),
      ]);
    });
  }

  private checkExpiredSwaps = async (height: number) => {
    const expirableSwaps = await this.swapRepository.getSwapsExpirable(height);
    this.logger.error("stacksnursery.400 checkExpiredSwaps " + expirableSwaps)

    for (const expirableSwap of expirableSwaps) {
      const { base, quote } = splitPairId(expirableSwap.pair);
      const chainCurrency = getChainCurrency(base, quote, expirableSwap.orderSide, false);

      const wallet = this.getEthereumWallet(chainCurrency);

      if (wallet) {
        this.emit('swap.expired', expirableSwap, wallet.symbol === 'RBTC');
      }
    }
  }

  private checkExpiredReverseSwaps = async (height: number) => {
    const expirableReverseSwaps = await this.reverseSwapRepository.getReverseSwapsExpirable(height);
    this.logger.error("stacksnursery.417 checkExpiredReverseSwaps " + expirableReverseSwaps)

    for (const expirableReverseSwap of expirableReverseSwaps) {
      const { base, quote } = splitPairId(expirableReverseSwap.pair);
      const chainCurrency = getChainCurrency(base, quote, expirableReverseSwap.orderSide, true);

      this.logger.error("stacksnursery.393 checkExpiredReverseSwaps, " + height + ", " + expirableReverseSwap.id)
      const wallet = this.getEthereumWallet(chainCurrency);

      if (wallet) {
        this.emit('reverseSwap.expired', expirableReverseSwap, wallet.symbol === 'RBTC');
      }
    }
  }

  /**
   * Returns a wallet in case there is one with the symbol and it is an Ethereum one
   */
  private getEthereumWallet = (symbol: string): Wallet | undefined => {
    const wallet = this.walletManager.wallets.get(symbol);

    if (!wallet) {
      return;
    }

    if (wallet.type === CurrencyType.Rbtc || wallet.type === CurrencyType.ERC20) {
      // this.logger.error("getEthereumWallet returning valid wallet");
      return wallet;
    }

    this.logger.error("getEthereumWallet returning empty!!");
    return;
  }
}

export default StacksNursery;
