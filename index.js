// TODO, filter out blocks

const smartweave = require("smartweave");
const { execute } = require("smartweave/lib/contract-step");
const { loadContract } = require("smartweave/lib/contract-load");
const { arrayToHex } = require("smartweave/lib/utils");
const SmartWeaveError = require("smartweave/lib/errors");
const { SmartWeaveErrorType } = require("smartweave/lib/errors");

/*
Contract object
{
  info: any,
  init_state: any,
  txs: any[]
}
*/

// the maximum number of transactions we can get from graphql at once
const MAX_REQUEST = 100;

// Cache singleton
const cache = {
  contracts: []
};

/**
 * Queries all interaction transactions and replays a contract to its latest state.
 *
 * If height is provided, will replay only to that block height.
 *
 * @param arweave         an Arweave client instance
 * @param contractId      the Transaction Id of the contract
 * @param height          if specified the contract will be replayed only to this block height
 * @param returnValidity  if true, the function will return valid and invalid transaction IDs along with the state
 */
async function readContract(arweave, contractId, height, returnValidity) {
  if (!height) {
    const networkInfo = await arweave.network.getInfo();
    height = networkInfo.height;
  }

  // If not contract in local cache, load and cache it
  let loadPromise;
  if (!cache.contracts[contractId]) {
    loadPromise = loadContract(arweave, contractId).catch(() => {
      const error = new SmartWeaveError(
        SmartWeaveErrorType.CONTRACT_NOT_FOUND,
        {
          message: `Contract having txId: ${contractId} not found`,
          requestedTxId: contractId
        }
      );
      throw error;
    });
    cache.contracts[contractId] = {
      txs: []
    };
  }

  const contractCache = cache.contracts[contractId];

  let fetchTxPromise;
  // If empty
  if (contractCache.txs.length === 0) {
    fetchTxPromise = fetchTransactions(arweave, contractId, 0);
  } else if (
    // Or last block is less than height
    getMaxHeight(contractCache.txs) < height
  ) {
    const min =
      contractCache.txs[contractCache.txs.length - 1].node.block.height + 1;
    fetchTxPromise = fetchTransactions(arweave, contractId, min);
  }

  let [contractInfo, newTxs] = await Promise.all([loadPromise, fetchTxPromise]);

  if (contractInfo instanceof Error) throw contractInfo;
  if (newTxs instanceof Error) throw newTxs;

  if (contractInfo !== undefined) contractCache.info = contractInfo;
  else contractInfo = contractCache.info;

  if (newTxs !== undefined) contractCache.txs.push(...newTxs);
  // TODO filter is slow, use binary search to find block.height > height, then slice(0, i)
  const txInfos = contractCache.txs.filter(
    (tx) => tx.node.block && tx.node.block.height <= height
  );

  let state;
  const contractSrcTXID = contractInfo.contractSrcTXID;
  try {
    state = JSON.parse(contractInfo.initState);
  } catch (e) {
    throw new Error(
      `Unable to parse initial state for contract: ${contractId}`
    );
  }

  // TODO, sort before pushing to tx array, that way we only have to sort the new txs instead of all of them
  await sortTransactions(arweave, txInfos);

  let { handler, swGlobal } = contractInfo;

  // Internal smartweave overwrite
  swGlobal.contracts.readContractState = (_contractId, _height, _returnValidity) =>
    readContract(
      arweave,
      _contractId,
      _height || (swGlobal._isDryRunning ? Number.POSITIVE_INFINITY : swGlobal.block.height),
      _returnValidity,
    );



  const validity = {};

  for (const txInfo of txInfos) {
    const currentTx = txInfo.node;

    const contractIndex = txInfo.node.tags.findIndex(
      (tag) => tag.name === "Contract" && tag.value === contractId
    );
    const inputTag = txInfo.node.tags[contractIndex + 1];

    if (!inputTag || inputTag.name !== "Input") continue;

    let input = inputTag.value;

    try {
      input = JSON.parse(input);
    } catch (e) {
      continue;
    }

    if (!input) continue;

    const interaction = {
      input,
      caller: currentTx.owner.address
    };

    swGlobal._activeTx = currentTx;

    const result = await execute(handler, interaction, state);
    validity[currentTx.id] = result.type === "ok";

    state = result.state;

    const settings = state.settings ? new Map(state.settings) : new Map();

    const evolve = state.evolve || settings.get("evolve");

    let canEvolve = state.canEvolve || settings.get("canEvolve");

    // By default, contracts can evolve if there's not an explicit `false`.
    if (canEvolve === undefined || canEvolve === null) {
      canEvolve = true;
    }

    if (evolve && /[a-z0-9_-]{43}/i.test(evolve) && canEvolve) {
      if (contractSrcTXID !== evolve) {
        try {
          contractInfo = await loadContract(arweave, contractId, evolve);
          handler = contractInfo.handler;
        } catch (e) {
          const error = new SmartWeaveError(
            SmartWeaveErrorType.CONTRACT_NOT_FOUND,
            {
              message: `Contract having txId: ${contractId} not found`,
              requestedTxId: contractId
            }
          );
          throw error;
        }
      }
    }
  }

  return returnValidity ? { state, validity } : state;
}

// Grab all transactions from a specific height
async function fetchTransactions(arweave, contractId, min) {
  let variables = {
    tags: [
      {
        name: "App-Name",
        values: ["SmartWeaveAction"]
      },
      {
        name: "Contract",
        values: [contractId]
      }
    ],
    blockFilter: {
      min // Inclusive, do last transaction + 1
    },
    first: MAX_REQUEST
  };

  let transactions = await getNextPage(arweave, variables);

  const txInfos = transactions.edges.filter(
    (tx) => !tx.node.parent || !tx.node.parent.id
  );

  while (transactions.pageInfo.hasNextPage) {
    const cursor = transactions.edges[MAX_REQUEST - 1].cursor;

    variables = {
      ...variables,
      after: cursor
    };

    transactions = await getNextPage(arweave, variables);

    txInfos.push(
      ...transactions.edges.filter(
        (tx) => !tx.node.parent || !tx.node.parent.id
      )
    );
  }

  return txInfos;
}

/**
 *
 * @param {*} txs
 * @returns {number} Last block height
 */
function getMaxHeight(txs) {
  for (let i = txs.length - 1; i >= 0; --i)
    if (txs[i].node.block) return txs[i].node.block.height;
  return 0;
}

// Exact copy of smartweave implementation
async function sortTransactions(arweave, txInfos) {
  const addKeysFuncs = txInfos.map((tx) => addSortKey(arweave, tx));
  await Promise.all(addKeysFuncs);
  txInfos.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}
async function addSortKey(arweave, txInfo) {
  const { node } = txInfo;
  const blockHashBytes = arweave.utils.b64UrlToBuffer(node.block.id);
  const txIdBytes = arweave.utils.b64UrlToBuffer(node.id);
  const concatted = arweave.utils.concatBuffers([blockHashBytes, txIdBytes]);
  const hashed = arrayToHex(await arweave.crypto.hash(concatted));
  const blockHeight = `000000${node.block.height}`.slice(-12);
  txInfo.sortKey = `${blockHeight},${hashed}`;
}
async function getNextPage(arweave, variables) {
  const query = `query Transactions($tags: [TagFilter!]!, $blockFilter: BlockFilter!, $first: Int!, $after: String) {
    transactions(tags: $tags, block: $blockFilter, first: $first, sort: HEIGHT_ASC, after: $after) {
      pageInfo {
        hasNextPage
      }
      edges {
        node {
          id
          owner { address }
          recipient
          tags {
            name
            value
          }
          block {
            height
            id
            timestamp
          }
          fee { winston }
          quantity { winston }
          parent { id }
        }
        cursor
      }
    }
  }`;
  const response = await arweave.api.post("graphql", {
    query,
    variables
  });
  if (response.status !== 200) {
    throw new Error(
      `Unable to retrieve transactions. Arweave gateway responded with status ${response.status}.`
    );
  }
  const data = response.data;
  const txs = data.data.transactions;
  return txs;
}

const smartweaveProxy = {
  readContract
};
for (const key in smartweave)
  if (key !== "readContract") smartweaveProxy[key] = smartweave[key];

module.exports = smartweaveProxy;
