const smartweave = require("smartweave");
const { execute } = require("smartweave/lib/contract-step");
const { loadContract } = require("smartweave/lib/contract-load");
const { arrayToHex } = require("smartweave/lib/utils");

// the maximum number of transactions we can get from graphql at once
const MAX_REQUEST = 100;

// Cache singleton
const cache = {
  contracts: {},
  height: 0,
  txQueue: []
};

/**
 * Reads contract and returns state if height matches, otherwise, executes
 *  new transactions across all contracts up to block height then return state
 * @param {Arweave} arweave Arweave client instance
 * @param {string} contractId Transaction Id of the contract
 * @param {number} height if specified the contract will be replayed only to this block height
 * @param {boolean} returnValidity if true, the function will return valid and invalid transaction IDs along with the state
 */
async function readContract(arweave, contractId, height, returnValidity) {
  // If height undefined, default to current network height
  height = height || (await arweave.network.getInfo()).height;

  // Load contract
  const resBase = await baseReadContract(
    arweave,
    contractId,
    height,
    returnValidity
  );
  if (resBase) return resBase;

  // Fetch and sort transactions for all contracts since cache height up to height
  cache.txQueue = cache.txQueue.concat(
    await fetchTransactions(
      arweave,
      Object.keys(cache.contracts),
      cache.height + 1,
      height
    )
  );
  await sortTransactions(arweave, cache.txQueue);

  // Execute every transaction in queue until empty
  while (cache.txQueue.length) {
    // Get transaction and corresponding contract
    const txInfo = cache.txQueue.shift();
    const txContractId = txInfo.node.tags.find(
      (tag) => tag.name === "Contract"
    ).value;
    const contractInfo = cache.contracts[txContractId].info;

    // Get transaction input
    let input = txInfo.node.tags.find((tag) => tag.name === "Input").value;
    try {
      input = JSON.parse(input);
    } catch (e) {
      continue;
    }
    if (!input) continue;

    // Setup execution env
    const currentTx = txInfo.node;
    const interaction = {
      input,
      caller: currentTx.owner.address
    };
    const { handler, swGlobal } = contractInfo;
    swGlobal._activeTx = currentTx;
    const validity = cache.contracts[txContractId].validity;

    // Execute and update contract
    const result = await execute(
      handler,
      interaction,
      cache.contracts[txContractId].state
    );
    validity[currentTx.id] = result.type === "ok";
    cache.contracts[txContractId].state = result.state;
    cache.height = currentTx.block ? currentTx.block.height : height;
  }

  // Update state cache and return state
  cache.height = height;
  return cloneReturn(contractId, returnValidity);

  // TODO FIXME Contract evolution is not supported
}

/**
 * Reads contract info and stores it in the cache, returns state if block height matches
 * @param {Arweave} arweave Arweave client instance
 * @param {string} contractId Transaction Id of the contract
 * @param {number} height if specified the contract will be replayed only to this block height
 * @param {boolean} returnValidity if true, the function will return valid and invalid transaction IDs along with the state
 */
async function baseReadContract(arweave, contractId, height, returnValidity) {
  // If not contract in local cache, load and cache it
  if (!cache.contracts[contractId]) {
    const contractInfo = await loadContract(arweave, contractId);
    contractInfo.swGlobal.contracts.readContractState = internalReadContract;
    cache.contracts[contractId] = {
      info: contractInfo,
      state: JSON.parse(contractInfo.initState),
      validity: {}
    };
  }

  // Handle height <= cache height
  if (height < cache.height)
    throw new Error("SWICW read heights must be non-decreasing");
  if (height === cache.height) return cloneReturn(contractId, returnValidity);
}

/**
 * Used for reading a contract within a contract, does not do any execution
 * @param {Arweave} arweave Arweave client instance
 * @param {string} contractId Transaction Id of the contract
 * @param {number} height if specified the contract will be replayed only to this block height
 * @param {boolean} returnValidity if true, the function will return valid and invalid transaction IDs along with the state
 */
async function internalReadContract(
  arweave,
  contractId,
  height,
  returnValidity
) {
  // If height undefined, default to current network height
  height = height || (await arweave.network.getInfo()).height;

  // Load contract
  const resBase = await baseReadContract(
    arweave,
    contractId,
    height,
    returnValidity
  );
  if (resBase) return resBase;

  // Fetch and sort transactions for this contract since cache height up to height
  cache.txQueue = cache.txQueue.concat(
    await fetchTransactions(arweave, [contractId], cache.height + 1, height)
  );
  await sortTransactions(arweave, cache.txQueue);
}

/**
 * Used to clone output variables so state cached isn't mutated
 * @param {string} contractId Contract ID whose state to clone
 * @param {boolean} returnValidity Wether to include the validity array
 * @returns {{any, any} | any} State or object that includes the state and validity array
 */
function cloneReturn(contractId, returnValidity) {
  const cacheContract = cache.contracts[contractId];
  const state = JSON.parse(JSON.stringify(cacheContract.state));

  if (returnValidity) {
    const validity = JSON.parse(JSON.stringify(cacheContract.state));
    return { state, validity };
  }
  return state;
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

// Create a proxy wrapper over the smartweave object for exporting
const smartweaveProxy = {
  readContract
};
for (const key in smartweave)
  if (key !== "readContract") smartweaveProxy[key] = smartweave[key];

module.exports = smartweaveProxy;
