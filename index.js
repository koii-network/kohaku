const { serialize, deserialize } = require("v8");
const { BigNumber } = require("bignumber.js");
const clarity = require("@weavery/clarity");
const smartweave = require("smartweave");
const { execute } = require("smartweave/lib/contract-step");
const {
  arrayToHex,
  getTag,
  normalizeContractSource
} = require("smartweave/lib/utils");
const { SmartWeaveGlobal } = require("smartweave/lib/smartweave-global");

// Maximum number of transactions we can get from graphql at once
const MAX_REQUEST = 100;
const CHUNK_SIZE = 2000;

/**
 * Cache singleton
 *
 * cache: {
 *   contracts: {
 *     [contractTxId]: {
 *       info: {
 *         contractSrcTxId: string,
 *         owner: string
 *       }
 *       state: unknown
 *       validity: {
 *         [transactionId]: boolean
 *       }
 *     }
 *   },
 *   contractSrcs: {
 *     [contractSrcTxId]: {
 *       contractSrc: string,
 *       handler: Function,
 *       isRecursive: boolean
 *     }
 *   },
 *   height: number
 * }
 */
let cache = {
  contracts: {},
  contractSrcs: {},
  height: 0
};

let readLock = false;
let swGlobal;

/**
 * Imports a cache externally. Used to improve startup times
 * @param {string} importString JSON string to be deserialized
 */
function importCache(arweave, importString) {
  if (!swGlobal) swGlobal = new SmartWeaveGlobal(arweave, {});
  cache = JSON.parse(importString);
  for (const contractSrcId in cache.contractSrcs) {
    const srcData = cache.contractSrcs[contractSrcId];
    const returningSrc = normalizeContractSource(srcData.contractSrc);
    const getContractFunction = new Function(returningSrc);
    srcData.handler = getContractFunction(swGlobal, BigNumber, clarity);
  }
}

/**
 * Exports the cache as a serialized JSON string, this can be slow so use sparingly
 * @param {string[]?} exportContracts Array containing contracts to export. Will export all contracts if falsy
 * @returns {string} Cache serialized in JSON as a string
 */
function exportCache(exportContracts) {
  if (!exportContracts) return JSON.stringify(cache);

  const contracts = {},
    contractSrcs = {};
  for (const id in cache.contracts) {
    if (!exportContracts.includes(id)) continue;
    contracts[id] = cache.contracts[id];
    const src = cache.contracts[id].info.contractSrcTxId;
    if (!(src in contractSrcs)) contractSrcs[src] = cache.contractSrcs[src];
  }
  return JSON.stringify({ contracts, contractSrcs, height: cache.height });
}

/**
 * Exports recursive contracts in the cache as a serialized JSON string, this can be slow so use sparingly
 * @param {string[]?} exportContracts Array containing recursive contracts to export. Will export all contracts if falsy
 * @returns {string} Cache serialized in JSON as a string
 */
function exportRecursiveCache(exportContracts) {
  const contracts = {},
    contractSrcs = {};
  for (const id in cache.contracts) {
    const src = cache.contracts[id].info.contractSrcTxId;
    if (
      (exportContracts && !exportContracts.includes(id)) ||
      !cache.contractSrcs[src].isRecursive
    )
      continue;
    contracts[id] = cache.contracts[id];
    if (!(src in contractSrcs)) contractSrcs[src] = cache.contractSrcs[src];
  }
  return JSON.stringify({ contracts, contractSrcs, height: cache.height });
}

/**
 * Reads a contract from the cache as a string, will error if contract is not present in cache
 * @param {string} contractId Transaction ID of the contract to read
 * @param {boolean} returnValidity if true, the function will return valid and invalid transaction IDs along with the state
 * @returns {{string} | {string, string}} String or object that includes the state and validity array as strings
 */
function readContractCache(contractId, returnValidity) {
  const state = cache.contracts[contractId].state;
  if (!returnValidity) return state;
  const validity = cache.contracts[contractId].validity;
  return { state, validity };
}

/**
 * Get Contract IDs in cache
 * @returns {string[]} Contract IDs in present cache
 */
function getCacheContractIds() {
  return Object.keys(cache.contracts);
}

/**
 * Checks whether a contract is cached
 * @param {string} contractId Transaction ID of the contract to check
 * @returns {boolean} Whether a contract is present in the cache
 */
function isContractCached(contractId) {
  return Object.prototype.hasOwnProperty.call(cache.contracts, contractId);
}

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

  // Return what's in the current cache if height <= cache height
  if (height < cache.height && height !== -1)
    console.warn(
      "Kohaku read height is less than cache height, defaulting to cache height"
    );
  if (height <= cache.height && contractId in cache.contracts) {
    const state = JSON.parse(cache.contracts[contractId].state);
    if (!returnValidity) return state;
    const validity = JSON.parse(cache.contracts[contractId].validity);
    return { state, validity };
  }
  if (height < cache.height) height = cache.height;
  if (!Object.keys(cache.contracts).length)
    console.log("Initializing Kohaku cache with root", contractId);

  // If not contract in local cache, load it
  let newContract;
  if (!cache.contracts[contractId]) {
    const [info, state] = await loadContract(arweave, contractId);
    // Return current height for newly loaded recursive contracts
    if (
      cache.contractSrcs[info.contractSrcTxId].isRecursive &&
      height === cache.height
    )
      return returnValidity ? { state, validity: {} } : state;
    newContract = {
      info,
      state,
      validity: {}
    };
  }

  // Fetch and sort transactions for all contracts since cache height up to height
  const partialReads = Object.keys(cache.contracts);
  let txQueue = [];
  if (newContract) {
    if (cache.contractSrcs[newContract.info.contractSrcTxId].isRecursive)
      partialReads.push(contractId);
    else
      txQueue = await fetchTransactions(
        arweave,
        [contractId],
        undefined,
        height
      );
  }
  txQueue = txQueue.concat(
    await fetchTransactions(arweave, partialReads, cache.height + 1, height)
  );
  await sortTransactions(arweave, txQueue);

  // Clone cache to new cache
  const newContracts = newContract ? { [contractId]: newContract } : {};
  for (const key in cache.contracts) {
    const contract = cache.contracts[key];
    newContracts[key] = {
      info: contract.info,
      state: JSON.parse(contract.state),
      validity: JSON.parse(contract.validity)
    };
  }
  const newCache = {
    contracts: newContracts,
    height: cache.height
  };

  // Sort and execute transactions to update the state
  while (txQueue.length) {
    const currentTx = txQueue.shift().node;
    if (currentTx.block.height > newCache.height)
      newCache.height = currentTx.block.height;
    await executeTx(currentTx);
  }

  // Save reference to results
  const state = newCache.contracts[contractId].state;
  const validity = newCache.contracts[contractId].validity;

  // Update state cache and return state, only update cache here so any errors won't mutate the cache
  for (const id in newCache.contracts) {
    const contract = newCache.contracts[id];
    // Cache as string for better immutability and clone performance
    contract.state = JSON.stringify(contract.state);
    contract.validity = JSON.stringify(contract.validity);
  }
  cache.contracts = newCache.contracts;
  cache.height = newCache.height;

  // Return results
  return returnValidity ? { state, validity } : state;

  // TODO FIXME Contract evolution is not supported

  /**
   * Used for reading a contract within a contract, does not do any execution unless non-recursive
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
      const [info, state] = await loadContract(arweave, _contractId);
      newCache.contracts[_contractId] = {
        info,
        state,
        validity: {}
      };

      let newTxs;
      // Add txs from recursive contracts to txQueue
      if (cache.contractSrcs[info.contractSrcTxId].isRecursive) {
        newTxs = await fetchTransactions(
          arweave,
          [_contractId],
          newCache.height + 1,
          height
        );
      } else {
        // For non recursive contracts, immediately execute txs below height
        newTxs = await fetchTransactions(
          arweave,
          [_contractId],
          undefined,
          height
        );

        if (newTxs.length) {
          await sortTransactions(arweave, newTxs);
          let i = 0;
          while (
            i < newTxs.length &&
            newTxs[i].node.block.height <= newCache.height
          )
            ++i;
          const nonRecTxs = newTxs.slice(0, i);
          while (nonRecTxs.length) await executeTx(nonRecTxs.shift().node);

          // Add remaining to txQueue
          newTxs = newTxs.slice(i);
        }
      }

      // Fetch and sort new transactions for this contract since cache height up to height
      if (newTxs.length) {
        txQueue = txQueue.concat(newTxs);
        await sortTransactions(arweave, txQueue);
      }
    }

    // Clone output variables so newCache state isn't mutated
    const cacheContract = newCache.contracts[_contractId];
    const state = clone(cacheContract.state);
    if (!_returnValidity) return state;
    const validity = clone(cacheContract.validity);
    return { state, validity };
  }

  async function executeTx(currentTx) {
    let txContractId, input;
    const tags = currentTx.tags;
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
    if (!txContractId) return;

    // Get transaction input
    try {
      input = JSON.parse(input);
    } catch (e) {
      return;
    }
    if (!input) return;

    // Setup execution env
    const contract = newCache.contracts[txContractId];
    const handler = cache.contractSrcs[contract.info.contractSrcTxId].handler;
    swGlobal.contract.id = txContractId;
    swGlobal.contract.owner = contract.info.owner;
    swGlobal.contracts.readContractState = internalReadContract; // TODO remove this from hotpath, only needs to be set once
    swGlobal._activeTx = currentTx;
    const interaction = { input, caller: currentTx.owner.address };

    // Execute and update contract
    const result = await execute(
      handler,
      interaction,
      newCache.contracts[txContractId].state
    );
    contract.validity[currentTx.id] = result.type === "ok";
    contract.state = result.state;
  }
}

/**
 * Loads the contract source, initial state and other parameters
 * @param arweave     an Arweave client instance
 * @param contractID  the Transaction Id of the contract
 */
async function loadContract(arweave, contractID, contractSrcTxId) {
  // Generate an object containing the details about a contract in one place.
  const contractTX = await arweave.transactions.get(contractID);
  const contractOwner = await arweave.wallets.ownerToAddress(contractTX.owner);

  contractSrcTxId = contractSrcTxId || getTag(contractTX, "Contract-Src");

  let state;
  if (getTag(contractTX, "Init-State")) {
    state = getTag(contractTX, "Init-State");
  } else if (getTag(contractTX, "Init-State-TX")) {
    const stateTX = await arweave.transactions.get(
      getTag(contractTX, "Init-State-TX")
    );
    state = stateTX.get("data", { decode: true, string: true });
  } else {
    state = contractTX.get("data", { decode: true, string: true });
  }

  if (!swGlobal) swGlobal = new SmartWeaveGlobal(arweave, {});

  if (
    !Object.prototype.hasOwnProperty.call(cache.contractSrcs, contractSrcTxId)
  ) {
    const contractSrcTX = await arweave.transactions.get(contractSrcTxId);
    const contractSrc = contractSrcTX.get("data", {
      decode: true,
      string: true
    });

    const returningSrc = normalizeContractSource(contractSrc);
    const getContractFunction = new Function(returningSrc);
    cache.contractSrcs[contractSrcTxId] = {
      contractSrc,
      handler: getContractFunction(swGlobal, BigNumber, clarity),
      isRecursive: contractSrc.includes("readContractState")
    };
  }
  
  return [
    {
      contractSrcTxId,
      owner: contractOwner
    },
    JSON.parse(state)
  ];
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
  min = min || 1; // Using a min block height of 1 removes null blocks
  let txInfos = [];

  for (let i = 0; i < contractIds.length; i += CHUNK_SIZE) {
    const chunk = contractIds.slice(i, i + CHUNK_SIZE);
    let variables = {
      tags: [
        { name: "App-Name", values: ["SmartWeaveAction"] },
        { name: "Contract", values: chunk }
      ],
      blockFilter: { min, max },
      first: MAX_REQUEST
    };

    let transactions = await getNextPage(arweave, variables);
    txInfos = txInfos.concat(
      transactions.edges.filter((tx) => !tx.node.parent || !tx.node.parent.id)
    );

    while (transactions.pageInfo.hasNextPage) {
      const cursor = transactions.edges[MAX_REQUEST - 1].cursor;
      variables = {
        ...variables,
        after: cursor
      };
      transactions = await getNextPage(arweave, variables);
      txInfos = txInfos.concat(
        transactions.edges.filter((tx) => !tx.node.parent || !tx.node.parent.id)
      );
    }
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

/**
 * Deep clones an object
 * @param {unknown} obj Object to be cloned
 * @returns {unknown} Cloned object
 */
function clone(obj) {
  return deserialize(serialize(obj));
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
  readContractCache,
  getCacheHeight,
  getCacheContractIds,
  isContractCached,
  importCache,
  exportCache,
  exportRecursiveCache
};
for (const key in smartweave)
  if (key !== "readContract") smartweaveProxy[key] = smartweave[key];

module.exports = smartweaveProxy;
