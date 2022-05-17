import { Op } from 'sequelize';
import { Request, Response } from 'express';
import Errors from './Errors';
import Logger from '../Logger';
import Service from '../service/Service';
import SwapNursery from '../swap/SwapNursery';
// import ServiceErrors from '../service/Errors';
import { SwapUpdate } from '../service/EventHandler';
import { SwapType, SwapUpdateEvent } from '../consts/Enums';
import { getChainCurrency, getHexBuffer, getVersion, mapToObject, parseTomlConfig, saveTomlConfig, splitPairId, stringify } from '../Utils';
import Config from '../Config';
import path from 'path';

type ApiArgument = {
  name: string,
  type: string,
  hex?: boolean,
  optional?: boolean,
};

class Controller {
  // A map between the ids and HTTP streams of all pending swaps
  private pendingSwapStreams = new Map<string, Response>();

  // A map between the ids and statuses of the swaps
  private pendingSwapInfos = new Map<string, SwapUpdate>();

  constructor(private logger: Logger, private service: Service) {
    this.service.eventHandler.on('swap.update', (id, message) => {
      this.logger.debug(`Swap ${id} update: ${stringify(message)}`);
      this.pendingSwapInfos.set(id, message);

      // console.log('controller.30 pendingswapinfo ', id, message);

      const response = this.pendingSwapStreams.get(id);

      if (response) {
        response.write(`data: ${JSON.stringify(message)}\n\n`);
      }
    });
  }

  public init = async (): Promise<void> => {
    // Get the latest status of all swaps in the database
    const [swaps, reverseSwaps] = await Promise.all([
      this.service.swapManager.swapRepository.getSwaps(),
      this.service.swapManager.reverseSwapRepository.getReverseSwaps(),
    ]);

    for (const swap of swaps) {
      const status = swap.status as SwapUpdateEvent;

      switch (status) {
        case SwapUpdateEvent.ChannelCreated: {
          const channelCreation = await this.service.swapManager.channelCreationRepository.getChannelCreation({
            swapId: {
              [Op.eq]: swap.id,
            },
          });

          this.pendingSwapInfos.set(swap.id, {
            status,
            channel: {
              fundingTransactionId: channelCreation!.fundingTransactionId!,
              fundingTransactionVout: channelCreation!.fundingTransactionVout!,
            },
          });

          break;
        }

        case SwapUpdateEvent.TransactionZeroConfRejected:
          this.pendingSwapInfos.set(swap.id, { status: SwapUpdateEvent.TransactionMempool, zeroConfRejected: true });
          break;

        default:
          this.pendingSwapInfos.set(swap.id, {
            status: swap.status as SwapUpdateEvent,
            failureReason: swap.failureReason,
          });
          break;
      }
    }

    for (const reverseSwap of reverseSwaps) {
      const status = reverseSwap.status as SwapUpdateEvent;

      switch (status) {
        case SwapUpdateEvent.TransactionMempool:
        case SwapUpdateEvent.TransactionConfirmed: {
          const { base, quote } = splitPairId(reverseSwap.pair);
          const chainCurrency = getChainCurrency(base, quote, reverseSwap.orderSide, true);

          try {
            // console.log("controller.91 TransactionConfirmed? ", status)
            const transactionHex = await this.service.getTransaction(chainCurrency, reverseSwap.transactionId!);
            // console.log("controller.93 transactionHex? ", transactionHex)

            this.pendingSwapInfos.set(reverseSwap.id, {
              status,
              transaction: {
                hex: transactionHex,
                id: reverseSwap.transactionId!,
                eta: status === SwapUpdateEvent.TransactionMempool ? SwapNursery.reverseSwapMempoolEta : undefined,
              },
            });
          } catch (error) {
            // If the transaction can't be queried with the service it's either a transaction on the Ethereum/RSK/Stacks network,
            // or something is terribly wrong

            // if(error.includes("Error: Request failed with status code 404")){
            //   how to handle when a tx is dropped from mempool???
            // }

            // if (error.message !== ServiceErrors.NOT_SUPPORTED_BY_SYMBOL(chainCurrency).message) {
            //   console.log("controller.106 NOT_SUPPORTED_BY_SYMBOL ", error);
            //   // failed tx on stacks chain we get
            //   // controller.106 NOT_SUPPORTED_BY_SYMBOL  Error: Request failed with status code 404
            //   throw error;
            // }

            console.log('controller.110 ', reverseSwap.id, status);
            this.pendingSwapInfos.set(reverseSwap.id, {
              status,
              transaction: {
                id: reverseSwap.transactionId!,
              },
            });
          }

          break;
        }

        default:
          this.pendingSwapInfos.set(reverseSwap.id, { status });
          break;
      }
    }
  }

  // GET requests
  public version = (_: Request, res: Response): void => {
    this.successResponse(res, {
      version: getVersion(),
    });
  }

  public getPairs = async (_: Request, res: Response): Promise<void> => {
    const data = await this.service.getPairs();

    // eslint-disable-next-line prefer-const
    let pairsObject = mapToObject(data.pairs);
    // console.log('controller.151 data ', pairsObject, data.clients);
    if(pairsObject['BTC/STX']) pairsObject['BTC/STX'].limits.maximal = data.clients.stxmax; // convert from clients mstx balance to boltz 10**8
    if(pairsObject['BTC/XUSD']) pairsObject['BTC/XUSD'].limits.maximal = data.clients.xusdmax; // convert from clients mstx balance to boltz 10**8

    // console.log('aggregator controller returning::: ', pairsObject);
    this.successResponse(res, {
      info: data.info,
      warnings: data.warnings,
      // pairs: mapToObject(data.pairs),
      pairs: pairsObject,
    });
  }

  public getNodes = async (_: Request, res: Response): Promise<void> => {
    const nodes = await this.service.getNodes();

    this.successResponse(res, {
      nodes: mapToObject(nodes),
    });
  }

  public getContracts = (req: Request, res: Response): void => {
    try {
      const contracts = this.service.getContracts();

      this.successResponse(res, {
        ethereum: {
          network: contracts.ethereum.network,
          swapContracts: mapToObject(contracts.ethereum.swapContracts),
          tokens: mapToObject(contracts.ethereum.tokens),
        },
        rsk: {
          network: contracts.rsk.network,
          swapContracts: mapToObject(contracts.rsk.swapContracts),
          tokens: mapToObject(contracts.rsk.tokens),
        },
      });
    } catch (error) {
      this.errorResponse(req, res, error, 501);
    }
  }

  public getFeeEstimation = async (_: Request, res: Response): Promise<void> => {
    const feeEstimation = await this.service.getFeeEstimation();

    this.successResponse(res, mapToObject(feeEstimation));
  }

  // POST requests
  public routingHints = (req: Request, res: Response): void => {
    try {
      const { symbol, routingNode } = this.validateRequest(req.body, [
        { name: 'symbol', type: 'string' },
        { name: 'routingNode', type: 'string' },
      ]);

      const routingHints = this.service.getRoutingHints(symbol, routingNode);

      this.successResponse(res, {
        routingHints,
      });
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public swapStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = this.validateRequest(req.body, [
        { name: 'id', type: 'string' },
      ]);

      const response = this.pendingSwapInfos.get(id);

      if (response) {
        this.successResponse(res, response);
      } else {
        this.errorResponse(req, res, `could not find swap with id: ${id}`, 404);
      }
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public zswapStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = this.validateRequest(req.body, [
        { name: 'id', type: 'string' },
      ]);

      const response = await this.service.getPendingSwapInfos(id);

      if (response.swapStatus) {
        this.successResponse(res, response.swapStatus);
      } else {
        this.errorResponse(req, res, `could not find swap with id: ${id}`, 404);
      }
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public swapRates = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = this.validateRequest(req.body, [
        { name: 'id', type: 'string' },
      ]);

      const response = await this.service.getSwapRates(id);
      this.successResponse(res, response);
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public getTransaction = async (req: Request, res: Response): Promise<void> => {
    try {
      const { currency, transactionId } = this.validateRequest(req.body, [
        { name: 'currency', type: 'string' },
        { name: 'transactionId', type: 'string' },
      ]);

      const response = await this.service.getTransaction(currency, transactionId);
      this.successResponse(res, { transactionHex: response });
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public getSwapTransaction = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = this.validateRequest(req.body, [
        { name: 'id', type: 'string' },
      ]);

      const response = await this.service.getSwapTransaction(id);
      this.successResponse(res, response);
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public broadcastTransaction = async (req: Request, res: Response): Promise<void> => {
    try {
      const { currency, transactionHex } = this.validateRequest(req.body, [
        { name: 'currency', type: 'string' },
        { name: 'transactionHex', type: 'string' },
      ]);

      const response = await this.service.broadcastTransaction(currency, transactionHex);
      this.successResponse(res, { transactionId: response });
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public broadcastSponsoredTx = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id, tx } = this.validateRequest(req.body, [
        { name: 'id', type: 'string' },
        { name: 'tx', type: 'string' },
      ]);

      const response = await this.service.broadcastSponsoredTx(id, tx);
      this.successResponse(res, { transactionId: response });
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public zbroadcastSponsoredTx = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id, tx } = this.validateRequest(req.body, [
        { name: 'id', type: 'string' },
        { name: 'tx', type: 'string' },
      ]);

      // const response = await this.service.broadcastSponsoredTx(id, tx);
      const response = await this.service.forwardSponsoredTx(id, tx);
      this.successResponse(res, { transactionId: response });
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public createSwap = async (req: Request, res: Response): Promise<void> => {
    try {
      const { type } = this.validateRequest(req.body, [
        { name: 'type', type: 'string' },
      ]);

      const swapType = this.parseSwapType(type);

      switch (swapType) {
        case SwapType.Submarine:
          await this.createSubmarineSwap(req, res);
          break;

        case SwapType.ReverseSubmarine:
          await this.createReverseSubmarineSwap(req, res);
          break;
      }

    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  public zcreateSwap = async (req: Request, res: Response): Promise<void> => {
    try {
      const { type } = this.validateRequest(req.body, [
        { name: 'type', type: 'string' },
      ]);

      const swapType = this.parseSwapType(type);

      // forward it to potential swap providers
      const response = await this.service.forwardSwap(req.body, swapType);
      // console.log('got response from client ', response.response);
      this.successResponse(res, response.response);
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  private createSubmarineSwap = async (req: Request, res: Response) => {
    const {
      pairId,
      pairHash,
      orderSide,
      invoice,
      refundPublicKey,
      preimageHash,
      channel,
      requestedAmount,
      claimAddress,
      baseAmount,
      quoteAmount,
    } = this.validateRequest(req.body, [
      { name: 'pairId', type: 'string' },
      { name: 'pairHash', type: 'string', optional: true },
      { name: 'orderSide', type: 'string' },
      { name: 'invoice', type: 'string', optional: true },
      { name: 'refundPublicKey', type: 'string', hex: true, optional: true },
      { name: 'preimageHash', type: 'string', hex: true, optional: true },
      { name: 'channel', type: 'object', optional: true },
      { name: 'requestedAmount', type: 'string', optional: true },
      { name: 'claimAddress', type: 'string', optional: true },
      { name: 'baseAmount', type: 'string', optional: true },
      { name: 'quoteAmount', type: 'string', optional: true },
    ]);

    if (channel !== undefined) {
      this.validateRequest(channel, [
        { name: 'auto', type: 'boolean' },
        { name: 'private', type: 'boolean' },
        { name: 'inboundLiquidity', type: 'number' },
      ]);
    }

    let response: any;

    if (invoice) {
      response = await this.service.createSwapWithInvoice(
        pairId,
        orderSide,
        refundPublicKey,
        invoice.toLowerCase(),
        pairHash,
        channel,
      );
    } else {
      // Check that the preimage hash was set
      this.validateRequest(req.body, [
        { name: 'preimageHash', type: 'string', hex: true },
      ]);

      this.checkPreimageHashLength(preimageHash);

      response = await this.service.createSwap({
        pairId,
        orderSide,
        refundPublicKey,
        preimageHash,
        channel,
        requestedAmount,
        claimAddress,
        baseAmount,
        quoteAmount,
      });
    }

    this.logger.verbose(`Created new Swap with id: ${response.id}`);
    this.logger.verbose(`Swap ${response.id}: ${stringify(response)}`);

    this.createdResponse(res, response);
  }

  private createReverseSubmarineSwap = async (req: Request, res: Response) => {
    const {
      pairId,
      pairHash,
      orderSide,
      routingNode,
      claimAddress,
      preimageHash,
      invoiceAmount,
      onchainAmount,
      claimPublicKey,
      prepayMinerFee,
      swapType,
    } = this.validateRequest(req.body, [
      { name: 'pairId', type: 'string' },
      { name: 'orderSide', type: 'string' },
      { name: 'preimageHash', type: 'string', hex: true },
      { name: 'pairHash', type: 'string', optional: true },
      { name: 'routingNode', type: 'string', optional: true },
      { name: 'claimAddress', type: 'string', optional: true, },
      { name: 'invoiceAmount', type: 'number', optional: true },
      { name: 'onchainAmount', type: 'number', optional: true },
      { name: 'prepayMinerFee', type: 'boolean', optional: true },
      { name: 'claimPublicKey', type: 'string', hex: true, optional: true },
      { name: 'swapType', type: 'string', optional: true },
    ]);

    this.checkPreimageHashLength(preimageHash);

    const response = await this.service.createReverseSwap({
      pairId,
      pairHash,
      orderSide,
      routingNode,
      claimAddress,
      preimageHash,
      invoiceAmount,
      onchainAmount,
      claimPublicKey,
      prepayMinerFee,
      swapType,
    });

    this.logger.verbose(`Created Reverse Swap with id: ${response.id}`);
    this.logger.silly(`Reverse swap ${response.id}: ${stringify(response)}`);

    this.createdResponse(res, response);
  }

  public setInvoice = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id, invoice, pairHash } = this.validateRequest(req.body, [
        { name: 'id', type: 'string' },
        { name: 'invoice', type: 'string' },
        { name: 'pairHash', type: 'string', optional: true },
      ]);

      const response = await this.service.setSwapInvoice(id, invoice.toLowerCase(), pairHash);
      this.successResponse(res, response);
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  // new endpoint to mint NFTs upon LN invoice payment
  public mintNFT = async (req: Request, res: Response): Promise<void> => {
    try {
      const { nftAddress, userAddress, contractSignature, stxAmount } = this.validateRequest(req.body, [
        { name: 'nftAddress', type: 'string' },
        { name: 'userAddress', type: 'string' },
        { name: 'contractSignature', type: 'string', optional: true },
        { name: 'stxAmount', type: 'number' },
      ]);

      const response = await this.service.mintNFT(nftAddress, userAddress, stxAmount, contractSignature);
      this.successResponse(res, response);
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  // new endpoint to registerClients that want to join swap provider network
  public registerClient = async (req: Request, res: Response): Promise<void> => {
    try {
      const { apiVersion, stacksAddress, nodeId, url, pairs, localLNBalance, remoteLNBalance, onchainBalance, StxBalance } = this.validateRequest(req.body, [
        { name: 'apiVersion', type: 'string' },
        { name: 'stacksAddress', type: 'string' },
        { name: 'nodeId', type: 'string' },
        { name: 'url', type: 'string' },
        { name: 'pairs', type: 'object',  },
        { name: 'localLNBalance', type: 'number', optional: true },
        { name: 'remoteLNBalance', type: 'number', optional: true},
        { name: 'onchainBalance', type: 'number', optional: true},
        { name: 'StxBalance', type: 'number', optional: true},
        // { name: 'stxAmount', type: 'number', optional: true },
      ]);

      const response = await this.service.registerClient(apiVersion, stacksAddress, nodeId, url, pairs, localLNBalance, remoteLNBalance, onchainBalance, StxBalance);
      this.successResponse(res, response);
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  // new endpoint to registerClients that want to join swap provider network
  public getLocked = async (req: Request, res: Response): Promise<void> => {
    try {
      const { preimageHash, swapContractAddress } = this.validateRequest(req.body, [
        { name: 'preimageHash', type: 'string' },
        // { name: 'amount', type: 'string' },
        // { name: 'claimPrincipal', type: 'string' },
        { name: 'swapContractAddress', type: 'string', },
        // { name: 'stxAmount', type: 'number', optional: true },
      ]);

      const response = await this.service.getLocked(preimageHash, swapContractAddress);
      this.successResponse(res, response);
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  // new endpoint for providers to update providerSwap status
  public updateSwapStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      // console.log('controller.532 updateSwapStatus req.body ', req.body);
      // eslint-disable-next-line prefer-const
      let { id, status, txId, failureReason, transaction, txHex } = this.validateRequest(req.body, [
        { name: 'id', type: 'string' },
        { name: 'status', type: 'string' },
        { name: 'txId', type: 'string', optional: true },
        { name: 'failureReason', type: 'string', optional: true },
        { name: 'transaction', type: 'object', optional: true },
        { name: 'txHex', type: 'string', optional: true },
        // { name: 'swapContractAddress', type: 'string', },
        // { name: 'stxAmount', type: 'number', optional: true },
      ]);

      const response = await this.service.updateSwapStatus(id, status, txId, failureReason);

      // console.log('controller.545 updateSwapStatus req.body ', id, status, txId, failureReason, transaction);

      // trigger swap.update so the pendingswapstreams get updated
      if(!transaction) transaction = {id: txId, hex: txHex}; // to keep frontend compatibility
      const message = {status, txId, failureReason, transaction};
      this.service.eventHandler.emit('swap.update', id, message);

      this.successResponse(res, response);
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }
  // EventSource streams
  public streamSwapStatus = (req: Request, res: Response): void => {
    try {
      const { id } = this.validateRequest(req.query, [
        { name: 'id', type: 'string' },
      ]);

      res.writeHead(200, {
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
      });

      res.setTimeout(0);

      this.pendingSwapStreams.set(id, res);

      res.on('close', () => {
        this.pendingSwapStreams.delete(id);
      });
    } catch (error) {
      this.errorResponse(req, res, error);
    }
  }

  /**
   * Validates that all required arguments were provided in the body correctly
   *
   * @returns the validated arguments
   */
  private validateRequest = (body: Record<string, any>, argsToCheck: ApiArgument[]) => {
    const response: any = {};

    argsToCheck.forEach((arg) => {
      const value = body[arg.name];

      if (value !== undefined) {
        if (typeof value === arg.type) {
          if (arg.hex && value !== '') {
            const buffer = getHexBuffer(value);

            if (buffer.length === 0) {
              throw Errors.COULD_NOT_PARSE_HEX(arg.name);
            }

            response[arg.name] = buffer;
          } else {
            response[arg.name] = value;
          }
        } else {
          throw Errors.INVALID_PARAMETER(arg.name);
        }
      } else if (!arg.optional) {
        throw Errors.UNDEFINED_PARAMETER(arg.name);
      }
    });

    return response;
  }

  public errorResponse = (req: Request, res: Response, error: unknown, statusCode = 400): void => {
    if (typeof error === 'string') {
      this.writeErrorResponse(req, res, statusCode, { error });
    } else {
      const errorObject = error as any;

      // Bitcoin Core related errors
      if (errorObject.details) {
        this.logger.error('Bitcoin Core related errors everything else');
        this.writeErrorResponse(req, res, statusCode, { error: errorObject.details });
      // Custom error when broadcasting a refund transaction fails because
      // the locktime requirement has not been met yet
      } else if (errorObject.timeoutBlockHeight) {
        this.logger.error('timeoutBlockHeight error everything else');
        this.writeErrorResponse(req, res, statusCode, error);
      // Everything else
      } else {
        this.logger.error('error everything else');
        this.writeErrorResponse(req, res, statusCode, { error: errorObject.message });
      }
    }
  }

  private successResponse = (res: Response, data: unknown) => {
    this.setContentTypeJson(res);
    res.status(200).json(data);
  }

  private createdResponse = (res: Response, data: unknown) => {
    this.setContentTypeJson(res);
    res.status(201).json(data);
  }

  private writeErrorResponse = (req: Request, res: Response, statusCode: number, error: unknown) => {
    this.logger.warn(`Request ${req.url} ${JSON.stringify(req.body)} failed: ${JSON.stringify(error)}`);

    this.setContentTypeJson(res);
    res.status(statusCode).json(error);
  }

  private setContentTypeJson = (res: Response) => {
    res.set('Content-Type', 'application/json');
  }

  private parseSwapType = (type: string) => {
    const lowerCaseType = type.toLowerCase();

    for (const swapType in SwapType) {
      if (lowerCaseType === SwapType[swapType]) {
        return lowerCaseType as SwapType;
      }
    }

    throw `could not find swap type: ${type}`;
  }

  private checkPreimageHashLength = (preimageHash: Buffer) => {
    if (preimageHash.length !== 32) {
      throw `invalid preimage hash length: ${preimageHash.length}`;
    }
  }

  public getAdminSwaps = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    // console.log('getAdminSwaps authHeader ', authHeader, tempAuthorizationHeader);
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    const data = await this.service.getAdminSwaps();
    // console.log('controller.597 getAdminSwaps data ', data);
    this.successResponse(res, data);
  }

  public getAdminReverseSwaps = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    const data = await this.service.getAdminReverseSwaps();
    this.successResponse(res, data);
  }

  public getAdminBalancerStatus = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    const data = await this.service.getAdminBalancerConfig();
    this.successResponse(res, data);
  }

  public getAdminBalancerBalances = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    const data = await this.service.getAdminBalancerBalances();
    this.successResponse(res, data);
  }

  public getAdminBalancer = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    const { pairId, buyAmount } = this.validateRequest(req.body, [
      { name: 'pairId', type: 'string' },
      { name: 'buyAmount', type: 'number' },
    ]);
    const data = await this.service.getAdminBalancer(pairId, buyAmount);
    this.successResponse(res, data);
  }

  public getAdminBalanceOffchain = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    const data = await this.service.getAdminBalanceOffchain();
    this.successResponse(res, data);
  }

  public getAdminBalanceOnchain = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    const data = await this.service.getAdminBalanceOnchain();
    this.successResponse(res, data);
  }

  public getAdminBalanceStacks = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    const data = await this.service.getAdminBalanceStacks();
    this.successResponse(res, data);
  }

  public getAdminConfiguration = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    // console.log('controller.694: ', Config.defaultDataDir, Config.defaultConfigPath, path.join(Config.defaultDataDir, Config.defaultConfigPath));
    const data = parseTomlConfig(path.join(Config.defaultDataDir, Config.defaultConfigPath));
    // console.log('controller.803 parseTomlConfig: ', data);
    this.successResponse(res, data);
  }

  public saveAdminConfiguration = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    console.log('controller.704 saveAdminConfiguration ', req.body);
    const { config } = this.validateRequest(req.body, [
      { name: 'config', type: 'object' },
    ]);
    const data = saveTomlConfig(config);
    console.log('controller.705 saveTomlConfig: ', data);
    this.successResponse(res, data);
  }

  public getAdminRestartApp = async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== this.service.getAdminDashboardAuth()) {
      this.errorResponse(req, res, 'unauthorized');
      return;
    }
    setTimeout(function () {
        process.on('exit', function () {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('child_process').spawn(process.argv.shift(), process.argv, {
                cwd: process.cwd(),
                detached : true,
                stdio: 'inherit'
            });
        });
        console.log('controller.729 restarting the app...');
        // eslint-disable-next-line no-process-exit
        process.exit();
    }, 5000);
    this.successResponse(res, 'OK');
  }
}

export default Controller;
