# kohaku

SmartWeave Incremental Cache Wrapper

Kohaku acts as a wrapper over SmartWeave but adds 3 rules to make cross-contract reading non-recursive.

1. Reads can only happen at the current height or greater
2. Transactions are only processed for a contract after it is registered in Kohaku's cache
3. Contracts are registered the first time they are read by Kohaku, whether internally or externally
4. Contracts that don't contain "readContractState" within its source is read from block 0 to global cache height

Failure to design around these rules will result in non-deterministic or incorrect contract states.
