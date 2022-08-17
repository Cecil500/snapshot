import { Result } from '@ethersproject/abi';
import { isAddress } from '@ethersproject/address';
import { isHexString } from '@ethersproject/bytes';
import { Contract } from '@ethersproject/contracts';
import { BigNumber } from '@ethersproject/bignumber';
import { _TypedDataEncoder } from '@ethersproject/hash';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { keccak256 as solidityKeccak256 } from '@ethersproject/solidity';
import {
  BigNumberish,
  isBigNumberish
} from '@ethersproject/bignumber/lib/bignumber';

import {
  call,
  multicall,
  sendTransaction
} from '@snapshot-labs/snapshot.js/src/utils';
import getProvider from '@snapshot-labs/snapshot.js/src/utils/provider';
import {
  SafeTransaction,
  RealityOracleProposal,
  SafeTransactionOperationType
} from '@/helpers/interfaces';
import {
  EIP712_TYPES,
  REALITY_MODULE_ABI,
  REALITY_ORACLE_ABI,
  ERC20_ABI
} from './constants';
import {
  buildQuestion,
  checkPossibleExecution,
  getModuleDetails,
  getProposalDetails
} from './utils/realityModule';
import { retrieveInfoFromOracle } from './utils/realityETH';
import { getNativeAsset } from '@/plugins/safeSnap/utils/coins';

export function validateTransaction(transaction: SafeTransaction) {
  const addressEmptyOrValidate =
    transaction.to === '' || isAddress(transaction.to);
  return (
    isBigNumberish(transaction.value) &&
    addressEmptyOrValidate &&
    (!transaction.data || isHexString(transaction.data)) &&
    transaction.operation in SafeTransactionOperationType &&
    isBigNumberish(transaction.nonce)
  );
}

export function calcTransactionHashes(
  chainId: number,
  moduleAddress: string,
  transactions: SafeTransaction[]
) {
  const domain = {
    chainId: chainId,
    verifyingContract: moduleAddress
  };
  return transactions.map(tx => {
    return _TypedDataEncoder.hash(domain, EIP712_TYPES, {
      ...tx,
      nonce: tx.nonce || '0',
      data: tx.data || '0x'
    });
  });
}

export async function getExecutionDetailsWithHashes(
  network: string,
  moduleAddress: string,
  proposalId: string,
  txHashes: string[]
): Promise<Omit<RealityOracleProposal, 'transactions'>> {
  const question = await buildQuestion(proposalId, txHashes);
  const questionHash = solidityKeccak256(['string'], [question]);

  const proposalDetails = await getProposalDetails(
    network,
    moduleAddress,
    questionHash,
    txHashes
  );
  const moduleDetails = await getModuleDetails(network, moduleAddress);
  const questionState = await checkPossibleExecution(
    network,
    moduleDetails.oracle,
    proposalDetails.questionId
  );
  const infoFromOracle = await retrieveInfoFromOracle(
    network,
    moduleDetails.oracle,
    proposalDetails.questionId
  );
  return {
    ...moduleDetails,
    proposalId,
    ...questionState,
    ...proposalDetails,
    txHashes,
    ...infoFromOracle
  };
}

export async function* submitProposalWithHashes(
  web3: any,
  moduleAddress: string,
  proposalId: string,
  txHashes: string[]
) {
  const tx = await sendTransaction(
    web3,
    moduleAddress,
    REALITY_MODULE_ABI,
    'addProposal',
    [proposalId, txHashes]
  );
  yield;
  const receipt = await tx.wait();
  console.log('[DAO module] submitted proposal:', receipt);
}

export async function loadClaimBondData(
  web3: any,
  network: string,
  questionId: string,
  oracleAddress: string,
  block: string
) {
  const contract = new Contract(oracleAddress, REALITY_ORACLE_ABI, web3);
  const provider: StaticJsonRpcProvider = getProvider(network);
  const account = (await web3.listAccounts())[0];

  const [[userBalance], [bestAnswer], [historyHash], [isFinalized]] =
    await multicall(network, provider, REALITY_ORACLE_ABI, [
      [oracleAddress, 'balanceOf', [account]],
      [oracleAddress, 'getBestAnswer', [questionId]],
      [oracleAddress, 'getHistoryHash', [questionId]],
      [oracleAddress, 'isFinalized', [questionId]]
    ]);

  const nativeToken = getNativeAsset(network);
  let token = {
    symbol: nativeToken.symbol,
    decimals: nativeToken.decimals
  };

  try {
    const tokenCall = await call(provider, REALITY_ORACLE_ABI, [
      oracleAddress,
      'token',
      []
    ]);
    const [[symbol], [decimals]] = await multicall(
      network,
      provider,
      ERC20_ABI,
      [
        [tokenCall, 'symbol', []],
        [tokenCall, 'decimals', []]
      ]
    );

    token = {
      symbol,
      decimals
    };
  } catch (e) {
    console.log('[Realitio] Info: Oracle is not ERC20 based.');
  }

  const answersFilter = contract.filters.LogNewAnswer(null, questionId);
  const events = await contract.queryFilter(answersFilter, parseInt(block));

  const users: Result[] = [];
  const historyHashes: Result[] = [];
  const bonds: Result[] = [];
  const answers: Result[] = [];

  // We need to send the information from last to first
  events.reverse();
  events.forEach(({ args }) => {
    users.push(args?.user.toLowerCase());
    historyHashes.push(args?.history_hash);
    bonds.push(args?.bond);
    answers.push(args?.answer);
  });

  const alreadyClaimed = BigNumber.from(historyHash).eq(0);
  const address = account.toLowerCase();

  // Check if current user has submitted an answer
  const currentUserAnswers = users.map((user, i) => {
    if (user === address) return answers[i];
  });

  // If the user has answers, check if one of them is the winner
  const votedForCorrectQuestion =
    currentUserAnswers.some(answer => {
      if (answer) {
        return BigNumber.from(answer).eq(bestAnswer);
      }
    }) && isFinalized;

  // If user has balance in the contract, he should be able to withdraw
  const hasBalance = !userBalance.eq(0) && isFinalized;

  // Remove the first history and add an empty one
  // More info: https://github.com/realitio/realitio-contracts/blob/master/truffle/contracts/Realitio.sol#L502
  historyHashes.shift();
  const firstHash =
    '0x0000000000000000000000000000000000000000000000000000000000000000' as unknown;
  historyHashes.push(firstHash as Result);

  return {
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    canClaim: (!alreadyClaimed && votedForCorrectQuestion) || hasBalance,
    data: {
      length: [bonds.length.toString()],
      historyHashes,
      users,
      bonds,
      answers
    }
  };
}

export async function* sendClaimBondTransaction(
  web3: any,
  oracleAddress: string,
  questionId: string,
  claimParams: [string[], string[], number[], string[]]
) {
  const currentHistoryHash = await call(web3, REALITY_ORACLE_ABI, [
    oracleAddress,
    'getHistoryHash',
    [questionId]
  ]);

  if (BigNumber.from(currentHistoryHash).eq(0)) {
    const withdrawTx = await sendTransaction(
      web3,
      oracleAddress,
      REALITY_ORACLE_ABI,
      'withdraw',
      []
    );
    yield;
    const withdrawReceipt = await withdrawTx.wait();
    console.log('[Realitio] executed withdraw:', withdrawReceipt);
    return;
  }

  const tx = await sendTransaction(
    web3,
    oracleAddress,
    REALITY_ORACLE_ABI,
    'claimMultipleAndWithdrawBalance',
    [[questionId], ...claimParams]
  );
  yield;
  const receipt = await tx.wait();
  console.log('[Realitio] executed claimMultipleAndWithdrawBalance:', receipt);
}

export async function* executeProposalWithHashes(
  web3: any,
  moduleAddress: string,
  proposalId: string,
  txHashes: string[],
  moduleTx: SafeTransaction,
  transactionIndex: number
) {
  const tx = await sendTransaction(
    web3,
    moduleAddress,
    REALITY_MODULE_ABI,
    'executeProposalWithIndex',
    [
      proposalId,
      txHashes,
      moduleTx.to,
      moduleTx.value,
      moduleTx.data || '0x',
      moduleTx.operation,
      transactionIndex
    ]
  );
  yield;
  const receipt = await tx.wait();
  console.log('[DAO module] executed proposal:', receipt);
}

export async function* voteForQuestion(
  network: string,
  web3: any,
  oracleAddress: string,
  questionId: string,
  minimumBondInDaoModule: BigNumberish,
  answer: '1' | '0'
) {
  const currentBond = await call(web3, REALITY_ORACLE_ABI, [
    oracleAddress,
    'getBond',
    [questionId]
  ]);

  let bond;
  let methodName;
  const txOverrides = {};
  let parameters = [
    questionId,
    `0x000000000000000000000000000000000000000000000000000000000000000${answer}`
  ];

  const currentBondIsZero = currentBond.eq(BigNumber.from(0));
  if (currentBondIsZero) {
    // DaoModules can have 0 minimumBond, if it happens, the initial bond will be 1 token
    const daoBondIsZero = BigNumber.from(minimumBondInDaoModule).eq(0);
    bond = daoBondIsZero ? BigNumber.from(10) : minimumBondInDaoModule;
  } else {
    bond = currentBond.mul(2);
  }

  // fetch token attribute from Realitio contract, if it works, it means it is
  // a RealitioERC20, otherwise the catch will handle the currency as ETH
  try {
    const account = (await web3.listAccounts())[0];
    const token = await call(web3, REALITY_ORACLE_ABI, [
      oracleAddress,
      'token',
      []
    ]);
    const [[tokenDecimals], [allowance]] = await multicall(
      network,
      web3,
      ERC20_ABI,
      [
        [token, 'decimals', []],
        [token, 'allowance', [account, oracleAddress]]
      ]
    );

    if (bond.eq(10)) {
      bond = bond.pow(tokenDecimals);
    }

    // Check if contract has allowance on user tokens,
    // if not, trigger approve method
    if (allowance.lt(bond)) {
      const approveTx = await sendTransaction(
        web3,
        token,
        ERC20_ABI,
        'approve',
        [oracleAddress, bond],
        {}
      );
      yield 'erc20-approval';
      const approvalReceipt = await approveTx.wait();
      console.log('[DAO module] token transfer approved:', approvalReceipt);
      yield;
    }
    parameters = [...parameters, bond, bond];
    methodName = 'submitAnswerERC20';
  } catch (e) {
    if (bond.eq(10)) {
      bond = bond.pow(18);
    }
    parameters = [...parameters, bond];
    txOverrides['value'] = bond.toString();
    methodName = 'submitAnswer';
  }

  const tx = await sendTransaction(
    web3,
    oracleAddress,
    REALITY_ORACLE_ABI,
    methodName,
    parameters,
    txOverrides
  );
  yield;
  const receipt = await tx.wait();
  console.log('[DAO module] executed vote on oracle:', receipt);
}
