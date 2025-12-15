export type BatchMethod = {
  method: string;
  label: string;
  defaultParams: string; // JSON string
};

export type InterfaceConfig = {
  regular: string | null;
  archive: string | null;
  debug: string | null;
  trace: string | null;
  batch?: {
    methods: BatchMethod[];
  };
};

export type ChainType = {
  value: string;
  label: string;
  interfaces: {
    [interfaceName: string]: InterfaceConfig;
  };
};

export const chainTypes: ChainType[] = [
  {
    value: 'evm',
    label: 'EVM',
    interfaces: {
      jsonrpc: {
        regular: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
        archive:
          '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","0x2C2A2"],"id":1}',
        debug:
          '{"jsonrpc":"2.0","method":"debug_traceBlockByNumber","params":["latest",{}],"id":1}',
        trace: '{"jsonrpc":"2.0","method":"trace_block","params":["latest"],"id":1}',
        batch: {
          methods: [
            { method: 'eth_blockNumber', label: 'Block Number', defaultParams: '[]' },
            { method: 'eth_chainId', label: 'Chain ID', defaultParams: '[]' },
            { method: 'eth_gasPrice', label: 'Gas Price', defaultParams: '[]' },
            { method: 'eth_getBalance', label: 'Get Balance', defaultParams: '["0x0000000000000000000000000000000000000000", "latest"]' },
            { method: 'net_version', label: 'Network Version', defaultParams: '[]' },
            { method: 'eth_syncing', label: 'Syncing Status', defaultParams: '[]' },
            { method: 'eth_getBlockByNumber', label: 'Get Block', defaultParams: '["latest", false]' },
            { method: 'eth_getTransactionCount', label: 'Transaction Count', defaultParams: '["0x0000000000000000000000000000000000000000", "latest"]' },
          ],
        },
      },
    },
  },
  {
    value: 'evm-arbitrum',
    label: 'Arbitrum',
    interfaces: {
      jsonrpc: {
        regular: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
        archive:
          '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","0x2C2A2"],"id":1}',
        debug:
          '{"jsonrpc":"2.0","method":"debug_traceBlockByNumber","params":["latest",{}],"id":1}',
        trace: '{"jsonrpc":"2.0","method":"arbstrace_block","params":["latest"],"id":1}',
        batch: {
          methods: [
            { method: 'eth_blockNumber', label: 'Block Number', defaultParams: '[]' },
            { method: 'eth_chainId', label: 'Chain ID', defaultParams: '[]' },
            { method: 'eth_gasPrice', label: 'Gas Price', defaultParams: '[]' },
            { method: 'eth_getBalance', label: 'Get Balance', defaultParams: '["0x0000000000000000000000000000000000000000", "latest"]' },
            { method: 'net_version', label: 'Network Version', defaultParams: '[]' },
            { method: 'eth_syncing', label: 'Syncing Status', defaultParams: '[]' },
            { method: 'eth_getBlockByNumber', label: 'Get Block', defaultParams: '["latest", false]' },
          ],
        },
      },
    },
  },
  {
    value: 'near',
    label: 'NEAR',
    interfaces: {
      jsonrpc: {
        regular: '{"jsonrpc":"2.0","method":"block","params":{"finality":"final"},"id":1}',
        archive:
          '{"jsonrpc":"2.0","method":"query","params":{"request_type":"view_account","account_id":"example.testnet","block_id":10000000},"id":1}',
        debug: null,
        trace: null,
        batch: {
          methods: [
            { method: 'block', label: 'Get Block', defaultParams: '{"finality":"final"}' },
            { method: 'status', label: 'Node Status', defaultParams: '[]' },
            { method: 'gas_price', label: 'Gas Price', defaultParams: '[null]' },
            { method: 'validators', label: 'Validators', defaultParams: '[null]' },
          ],
        },
      },
    },
  },
  {
    value: 'solana',
    label: 'Solana',
    interfaces: {
      jsonrpc: {
        regular: '{"jsonrpc":"2.0","method":"getBlockHeight","params":[],"id":1}',
        archive: null,
        debug: null,
        trace:
          '{"jsonrpc":"2.0","method":"getTransaction","params":["5FtxSignatureHere",{"maxSupportedTransactionVersion":0}],"id":1}',
        batch: {
          methods: [
            { method: 'getBlockHeight', label: 'Block Height', defaultParams: '[]' },
            { method: 'getSlot', label: 'Current Slot', defaultParams: '[]' },
            { method: 'getEpochInfo', label: 'Epoch Info', defaultParams: '[]' },
            { method: 'getHealth', label: 'Health', defaultParams: '[]' },
            { method: 'getVersion', label: 'Version', defaultParams: '[]' },
            { method: 'getRecentBlockhash', label: 'Recent Blockhash', defaultParams: '[]' },
          ],
        },
      },
    },
  },
  {
    value: 'cosmos',
    label: 'Cosmos',
    interfaces: {
      tendermintrpc: {
        regular: '{"jsonrpc":"2.0","method":"status","params":[],"id":1}',
        archive: '{"jsonrpc":"2.0","method":"block","params":{"height":"340801"},"id":1}',
        debug: null,
        trace: null,
      },
      rest: {
        regular: '{"method":"GET","path":"/cosmos/base/tendermint/v1beta1/blocks/latest"}',
        archive: '{"method":"GET","path":"/cosmos/base/tendermint/v1beta1/blocks/340801"}',
        debug: null,
        trace: null,
      },
      grpc: {
        regular: '{"method":"/cosmos.base.tendermint.v1beta1.Service/GetLatestBlock"}',
        archive:
          '{"method":"/cosmos.base.tendermint.v1beta1.Service/GetBlockByHeight","params":{"height":"340801"}}',
        debug: null,
        trace: null,
      },
    },
  },
  {
    value: 'starknet',
    label: 'Starknet',
    interfaces: {
      jsonrpc: {
        regular: '{"jsonrpc":"2.0","method":"starknet_blockNumber","params":[],"id":1}',
        archive:
          '{"jsonrpc":"2.0","method":"starknet_getStorageAt","params":{"contract_address":"0x0123","key":"0x0","block_id":{"block_number":123456}},"id":1}',
        debug: null,
        trace:
          '{"jsonrpc":"2.0","method":"starknet_traceTransaction","params":{"transaction_hash":"0xTXHASH"},"id":1}',
        batch: {
          methods: [
            { method: 'starknet_blockNumber', label: 'Block Number', defaultParams: '[]' },
            { method: 'starknet_chainId', label: 'Chain ID', defaultParams: '[]' },
            { method: 'starknet_syncing', label: 'Syncing Status', defaultParams: '[]' },
            { method: 'starknet_blockHashAndNumber', label: 'Block Hash & Number', defaultParams: '[]' },
          ],
        },
      },
    },
  },
  {
    value: 'tron',
    label: 'Tron',
    interfaces: {
      rest: {
        regular: '{"method":"GET","path":"/wallet/getnodeinfo"}',
        archive: null,
        debug: null,
        trace: null,
      },
    },
  },
  {
    value: 'ton',
    label: 'TON',
    interfaces: {
      rest: {
        regular: '{"method":"GET","path":"/api/v2/getWalletInformation"}',
        archive: null,
        debug: null,
        trace: null,
      },
    },
  },
  {
    value: 'xlm',
    label: 'XLM',
    interfaces: {
      jsonrpc: {
        regular: '{"jsonrpc":"2.0","id":8675309,"method":"getVersionInfo"}',
        archive: null,
        debug: null,
        trace: null,
        batch: {
          methods: [
            { method: 'getVersionInfo', label: 'Version Info', defaultParams: '[]' },
            { method: 'getHealth', label: 'Health', defaultParams: '[]' },
            { method: 'getNetwork', label: 'Network', defaultParams: '[]' },
          ],
        },
      },
      rest: {
        regular:
          '{"method":"GET","path":"/transactions/2a51b7475e3596cf4ece98c2b017eeab6b292d7d14c861d060cd3b1e164b5608"}',
        archive: null,
        debug: null,
        trace: null,
      },
    },
  },
  {
    value: 'xrp',
    label: 'XRP',
    interfaces: {
      rest: {
        regular: '{"jsonrpc":"2.0","id":1,"method":"server_info","params":[]}',
        archive: null,
        debug: null,
        trace: null,
      },
    },
  },
  {
    value: 'aptos',
    label: 'Aptos',
    interfaces: {
      rest: {
        regular: '{"method":"GET","path":"/"}',
        archive: null,
        debug: null,
        trace: null,
      },
    },
  },
  {
    value: 'bitcoin',
    label: 'Bitcoin',
    interfaces: {
      jsonrpc: {
        regular: '{"jsonrpc":"2.0","method":"getblockcount","params":[],"id":1}',
        archive: '{"jsonrpc":"2.0","method":"getblockhash","params":[800000],"id":1}',
        debug: null,
        trace: null,
        batch: {
          methods: [
            { method: 'getblockcount', label: 'Block Count', defaultParams: '[]' },
            { method: 'getbestblockhash', label: 'Best Block Hash', defaultParams: '[]' },
            { method: 'getblockchaininfo', label: 'Blockchain Info', defaultParams: '[]' },
            { method: 'getnetworkinfo', label: 'Network Info', defaultParams: '[]' },
            { method: 'getmempoolinfo', label: 'Mempool Info', defaultParams: '[]' },
          ],
        },
      },
    },
  },
  {
    value: 'hedera',
    label: 'Hedera',
    interfaces: {
      jsonrpc: {
        regular: '{"jsonrpc":"2.0","method":"getAccountInfo","params":{"account":{"accountId":"0.0.1"}},"id":1}',
        archive: '{"jsonrpc":"2.0","method":"getAccountInfo","params":{"account":{"accountId":"0.0.1"},"blockNumber":"latest"},"id":1}',
        debug: null,
        trace: null,
        batch: {
          methods: [
            { method: 'getAccountInfo', label: 'Account Info', defaultParams: '{"account":{"accountId":"0.0.1"}}' },
            { method: 'getLedgerId', label: 'Ledger ID', defaultParams: '[]' },
          ],
        },
      },
      rest: {
        regular: '{"method":"GET","path":"/api/v1/accounts/0.0.1"}',
        archive: '{"method":"GET","path":"/api/v1/accounts/0.0.1?block=latest"}',
        debug: null,
        trace: null,
      },
    },
  },
];
