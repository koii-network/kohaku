const smartweave = require("smartweave");
const { execute } = require("smartweave/lib/contract-step");
const { loadContract } = require("smartweave/lib/contract-load");
const { arrayToHex } = require("smartweave/lib/utils");

// the maximum number of transactions we can get from graphql at once
const MAX_REQUEST = 100;

// Cache singleton
let cache = {
  contracts: {},
  height: 0
};
let newCache;
let txQueue;
let readLock = false;

/**
 * Mutex-like lock to prevent state rewriting
 * @param {Arweave} arweave Arweave client instance
 * @param {string} contractId Transaction Id of the contract
 * @param {number} height if specified the contract will be replayed only to this block height
 * @param {boolean} returnValidity if true, the function will return valid and invalid transaction IDs along with the state
 */
async function readContract(arweave, contractId, height, returnValidity) {
  if (readLock) return _readContract(arweave, contractId, -1, returnValidity);
  readLock = true;
  try {
    const res = await _readContract(
      arweave,
      contractId,
      height,
      returnValidity
    );
    readLock = false;
    return res;
  } catch (e) {
    readLock = false;
    throw e;
  }
}

/**
 * Reads contract and returns state if height matches, otherwise, executes
 *  new transactions across all contracts up to block height then return state
 * @param {Arweave} arweave Arweave client instance
 * @param {string} contractId Transaction Id of the contract
 * @param {number} height if specified the contract will be replayed only to this block height
 * @param {boolean} returnValidity if true, the function will return valid and invalid transaction IDs along with the state
 */
async function _readContract(arweave, contractId, height, returnValidity) {
  // If height undefined, default to current network height
  if (typeof height !== "number")
    height = (await arweave.network.getInfo()).height;

  if (!Object.keys(cache.contracts).length)
    console.log("Initializing Kohaku cache with root", contractId);

  // Clone cache to new cache (except for info, copy reference)
  const newContracts = {};
  for (const key in cache.contracts) {
    const contract = cache.contracts[key];
    newContracts[key] = {
      info: contract.info,
      state: clone(contract.state),
      validity: clone(contract.validity)
    };
  }
  newCache = {
    contracts: newContracts,
    height: cache.height
  };

  // If not contract in local cache
  if (!newCache.contracts[contractId]) {
    // Load and cache it
    const contractInfo = await loadContract(arweave, contractId);
    contractInfo.swGlobal.contracts.readContractState = internalReadContract;
    newCache.contracts[contractId] = {
      info: contractInfo,
      state: JSON.parse(contractInfo.initState),
      validity: {}
    };
  }

  if (height < newCache.height && height !== -1)
    console.warn(
      "Kohaku read height is less than cache height, defaulting to cache height"
    );
  if (height <= newCache.height) return cloneReturn(contractId, returnValidity);

  // Fetch and sort transactions for all contracts since cache height up to height
  txQueue = await fetchTransactions(
    arweave,
    Object.keys(newCache.contracts),
    newCache.height + 1,
    height
  );
  await sortTransactions(arweave, txQueue);

  // Execute every transaction in queue until empty
  while (txQueue.length) {
    // Dequeue the transaction
    const txInfo = txQueue.shift();

    // Find contract and input tag
    let txContractId, input;
    const tags = txInfo.node.tags;
    for (let i = 0; i < tags.length - 1; ++i) {
      if (
        tags[i].name === "Contract" &&
        tags[i].value in newCache.contracts &&
        tags[i + 1].name === "Input"
      ) {
        txContractId = tags[i].value;
        input = tags[i + 1].value;
        break;
      }
    }
    if (!txContractId) continue;

    // Get transaction input
    try {
      input = JSON.parse(input);
    } catch (e) {
      continue;
    }
    if (!input) continue;

    // Setup execution env
    const { handler, swGlobal } = newCache.contracts[txContractId].info;
    const currentTx = txInfo.node;
    swGlobal._activeTx = currentTx;
    const interaction = { input, caller: currentTx.owner.address };
    const validity = newCache.contracts[txContractId].validity;
    newCache.height = currentTx.block.height;

    // Execute and update contract
    const result = await execute(
      handler,
      interaction,
      newCache.contracts[txContractId].state
    );
    validity[currentTx.id] = result.type === "ok";
    newCache.contracts[txContractId].state = result.state;
  }

  // Update state cache and return state
  cache = newCache; // Only update cache here so any errors won't mutate the cache
  return cloneReturn(contractId, returnValidity);

  // TODO FIXME Contract evolution is not supported

  /**
   * Used for reading a contract within a contract, does not do any execution
   * @param {string} contractId Transaction Id of the contract
   */
  async function internalReadContract(_contractId, _height, _returnValidity) {
    _height = _height || newCache.height;
    if (_height !== newCache.height)
      throw new Error(
        "Kohaku internal read height must match transaction height"
      );

    // If not contract in local cache
    if (!newCache.contracts[_contractId]) {
      // Load and cache it
      const contractInfo = await loadContract(arweave, _contractId);
      contractInfo.swGlobal.contracts.readContractState = internalReadContract;
      newCache.contracts[_contractId] = {
        info: contractInfo,
        state: JSON.parse(contractInfo.initState),
        validity: {}
      };

      // Fetch and sort transactions for this contract since cache height up to height
      const newTxs = await fetchTransactions(
        arweave,
        [_contractId],
        newCache.height + 1,
        height
      );
      if (newTxs.length) {
        txQueue = txQueue.concat(newTxs);
        await sortTransactions(arweave, txQueue);
      }
    }

    return cloneReturn(_contractId, _returnValidity);
  }
}

/**
 * Used to clone output variables so state cached isn't mutated
 * @param {string} contractId Contract ID whose state to clone
 * @param {boolean} returnValidity Wether to include the validity array
 * @returns {{any, any} | any} State or object that includes the state and validity array
 */
function cloneReturn(contractId, returnValidity) {
  const cacheContract = newCache.contracts[contractId];
  const state = clone(cacheContract.state);
  if (!returnValidity) return state;

  const validity = clone(cacheContract.validity);
  return { state, validity };
}

/**
 * Create a deep clone of a object
 * @param {*} obj Object to be cloned
 */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Grab all transactions from a specific height
 * @param {Arweave} arweave Arweave client instance
 * @param {string[]} contractIds Array of contract IDs to fetch
 * @param {number} min Lowest block to fetch from
 * @param {number} max Highest block to fetch from
 * @returns {any[]} Transaction objects
 */
async function fetchTransactions(arweave, contractIds, min, max) {
  let variables = {
    tags: [
      { name: "App-Name", values: ["SmartWeaveAction"] },
      { name: "Contract", values: contractIds }
    ],
    blockFilter: { min, max },
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
 * Get cache height
 * returns {number} Last guaranteed block height processed
 */
function getCacheHeight() {
  return cache.height;
}

/**
 * Gets the next GQL page and check for null blocks. Throws error on null block
 * @param {Arweave} arweave Arweave instance
 * @param {*} variables GQL query variables
 * @returns {*[]} Array of transactions
 */
async function getNextPage(arweave, variables) {
  const query = `query Transactions($tags: [TagFilter!]!, $blockFilter: BlockFilter!, $first: Int!, $after: String) {
    transactions(tags: $tags, block: $blockFilter, first: $first, sort: HEIGHT_ASC, after: $after) {
      pageInfo { hasNextPage }
      edges {
        node {
          id
          owner { address }
          recipient
          tags { name value }
          block { height id timestamp }
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

  if (txs.edges.some((tx) => tx.node.block === null)) {
    const nullBlockError = new Error("Null block found");
    nullBlockError.name = "Null block";
    throw nullBlockError;
  }
  return txs;
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

// Create a proxy wrapper over the smartweave object for exporting
const smartweaveProxy = {
  readContract,
  getCacheHeight
};
for (const key in smartweave)
  if (key !== "readContract") smartweaveProxy[key] = smartweave[key];

module.exports = smartweaveProxy;
