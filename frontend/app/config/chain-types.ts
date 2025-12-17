export type BatchMethod = {
  method: string;
  label: string;
  defaultParams: string; // JSON string
};

// Command definition for regular/addon request types
export type AddonCommand = {
  method: string;
  label: string;
  params: string; // JSON string of params
};

export type BatchConfig = {
  regular: BatchMethod[];
  archive?: BatchMethod[];
  debug?: BatchMethod[];
  trace?: BatchMethod[];
};

export type InterfaceConfig = {
  regular: AddonCommand[];
  archive: AddonCommand[] | null;
  debug: AddonCommand[] | null;
  trace: AddonCommand[] | null;
  batch?: BatchConfig;
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
        regular: [
          { method: 'eth_blockNumber', label: 'Block Number', params: '[]' },
          { method: 'eth_chainId', label: 'Chain ID', params: '[]' },
          { method: 'eth_gasPrice', label: 'Gas Price', params: '[]' },
          {
            method: 'eth_getBalance',
            label: 'Get Balance',
            params: '["0x0000000000000000000000000000000000000000", "latest"]',
          },
          { method: 'net_version', label: 'Network Version', params: '[]' },
          { method: 'eth_syncing', label: 'Syncing Status', params: '[]' },
          { method: 'eth_getBlockByNumber', label: 'Get Block', params: '["latest", false]' },
        ],
        archive: [
          {
            method: 'eth_getBalance',
            label: 'Get Balance (Archive)',
            params: '["0x0000000000000000000000000000000000000000", "0x2C2A2"]',
          },
          {
            method: 'eth_getStorageAt',
            label: 'Get Storage At',
            params: '["0x0000000000000000000000000000000000000000", "0x0", "0x2C2A2"]',
          },
          {
            method: 'eth_getCode',
            label: 'Get Code',
            params: '["0x0000000000000000000000000000000000000000", "0x2C2A2"]',
          },
        ],
        debug: [
          {
            method: 'debug_traceBlockByNumber',
            label: 'Trace Block By Number',
            params: '["latest", {"tracer":"callTracer"}]',
          },
          {
            method: 'debug_traceBlockByHash',
            label: 'Trace Block By Hash',
            params: '["latest", {"tracer":"callTracer"}]',
          },
          {
            method: 'debug_traceTransaction',
            label: 'Trace Transaction',
            params: '["latest", {"tracer":"callTracer"}]',
          },
        ],
        trace: [
          { method: 'trace_block', label: 'Trace Block', params: '["latest"]' },
          {
            method: 'trace_transaction',
            label: 'Trace Transaction',
            params: '["0x0000000000000000000000000000000000000000000000000000000000000000"]',
          },
          {
            method: 'trace_replayBlockTransactions',
            label: 'Replay Block Transactions',
            params: '["latest", ["trace"]]',
          },
        ],
        batch: {
          regular: [
            { method: 'eth_blockNumber', label: 'Block Number', defaultParams: '[]' },
            { method: 'eth_chainId', label: 'Chain ID', defaultParams: '[]' },
            { method: 'eth_gasPrice', label: 'Gas Price', defaultParams: '[]' },
            {
              method: 'eth_getBalance',
              label: 'Get Balance',
              defaultParams: '["0x0000000000000000000000000000000000000000", "latest"]',
            },
            { method: 'net_version', label: 'Network Version', defaultParams: '[]' },
            { method: 'eth_syncing', label: 'Syncing Status', defaultParams: '[]' },
            {
              method: 'eth_getBlockByNumber',
              label: 'Get Block',
              defaultParams: '["latest", false]',
            },
            {
              method: 'eth_getTransactionCount',
              label: 'Transaction Count',
              defaultParams: '["0x0000000000000000000000000000000000000000", "latest"]',
            },
            {
              method: 'eth_getBlockReceipts',
              label: 'Get Block Receipts',
              defaultParams: '["latest"]',
            },
            {
              method: 'eth_getTransactionReceipt',
              label: 'Get Transaction Receipt',
              defaultParams: '["latest"]',
            },
          ],
          archive: [
            {
              method: 'eth_getBalance',
              label: 'Get Balance (Archive)',
              defaultParams: '["0x0000000000000000000000000000000000000000", "0x2C2A2"]',
            },
            {
              method: 'eth_getStorageAt',
              label: 'Get Storage At (Archive)',
              defaultParams: '["0x0000000000000000000000000000000000000000", "0x0", "0x2C2A2"]',
            },
            {
              method: 'eth_getCode',
              label: 'Get Code (Archive)',
              defaultParams: '["0x0000000000000000000000000000000000000000", "0x2C2A2"]',
            },
          ],
          debug: [
            {
              method: 'debug_traceBlockByNumber',
              label: 'Trace Block By Number',
              defaultParams: '["latest", {"tracer":"callTracer"}]',
            },
            {
              method: 'debug_traceBlockByHash',
              label: 'Trace Block By Hash',
              defaultParams: '["latest", {"tracer":"callTracer"}]',
            },
            {
              method: 'debug_traceTransaction',
              label: 'Trace Transaction',
              defaultParams: '["latest", {"tracer":"callTracer"}]',
            },
          ],
          trace: [
            { method: 'trace_block', label: 'Trace Block', defaultParams: '["latest"]' },
            {
              method: 'trace_transaction',
              label: 'Trace Transaction',
              defaultParams:
                '["0x0000000000000000000000000000000000000000000000000000000000000000"]',
            },
            {
              method: 'trace_replayBlockTransactions',
              label: 'Replay Block Transactions',
              defaultParams: '["latest", ["trace"]]',
            },
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
        regular: [
          { method: 'eth_blockNumber', label: 'Block Number', params: '[]' },
          { method: 'eth_chainId', label: 'Chain ID', params: '[]' },
          { method: 'eth_gasPrice', label: 'Gas Price', params: '[]' },
          {
            method: 'eth_getBalance',
            label: 'Get Balance',
            params: '["0x0000000000000000000000000000000000000000", "latest"]',
          },
          { method: 'net_version', label: 'Network Version', params: '[]' },
          { method: 'eth_syncing', label: 'Syncing Status', params: '[]' },
          { method: 'eth_getBlockByNumber', label: 'Get Block', params: '["latest", false]' },
        ],
        archive: [
          {
            method: 'eth_getBalance',
            label: 'Get Balance (Archive)',
            params: '["0x0000000000000000000000000000000000000000", "0x2C2A2"]',
          },
        ],
        debug: [
          {
            method: 'debug_traceBlockByNumber',
            label: 'Trace Block By Number',
            params: '["latest", {"tracer":"callTracer"}]',
          },
          {
            method: 'debug_traceBlockByHash',
            label: 'Trace Block By Hash',
            params: '["latest", {"tracer":"callTracer"}]',
          },
          {
            method: 'debug_traceTransaction',
            label: 'Trace Transaction',
            params: '["latest", {"tracer":"callTracer"}]',
          },
        ],
        trace: [{ method: 'arbstrace_block', label: 'Arb Trace Block', params: '["latest"]' }],
        batch: {
          regular: [
            { method: 'eth_blockNumber', label: 'Block Number', defaultParams: '[]' },
            { method: 'eth_chainId', label: 'Chain ID', defaultParams: '[]' },
            { method: 'eth_gasPrice', label: 'Gas Price', defaultParams: '[]' },
            {
              method: 'eth_getBalance',
              label: 'Get Balance',
              defaultParams: '["0x0000000000000000000000000000000000000000", "latest"]',
            },
            { method: 'net_version', label: 'Network Version', defaultParams: '[]' },
            { method: 'eth_syncing', label: 'Syncing Status', defaultParams: '[]' },
            {
              method: 'eth_getBlockByNumber',
              label: 'Get Block',
              defaultParams: '["latest", false]',
            },
          ],
          archive: [
            {
              method: 'eth_getBalance',
              label: 'Get Balance (Archive)',
              defaultParams: '["0x0000000000000000000000000000000000000000", "0x2C2A2"]',
            },
          ],
          debug: [
            {
              method: 'debug_traceBlockByNumber',
              label: 'Trace Block By Number',
              defaultParams: '["latest", {"tracer":"callTracer"}]',
            },
            {
              method: 'debug_traceBlockByHash',
              label: 'Trace Block By Hash',
              defaultParams: '["latest", {"tracer":"callTracer"}]',
            },
            {
              method: 'debug_traceTransaction',
              label: 'Trace Transaction',
              defaultParams: '["latest", {"tracer":"callTracer"}]',
            },
          ],
          trace: [
            { method: 'arbstrace_block', label: 'Arb Trace Block', defaultParams: '["latest"]' },
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
        regular: [
          { method: 'block', label: 'Get Block', params: '{"finality":"final"}' },
          { method: 'status', label: 'Node Status', params: '[]' },
          { method: 'gas_price', label: 'Gas Price', params: '[null]' },
          { method: 'validators', label: 'Validators', params: '[null]' },
        ],
        archive: [
          {
            method: 'query',
            label: 'Query (Archive)',
            params:
              '{"request_type":"view_account","account_id":"example.testnet","block_id":10000000}',
          },
        ],
        debug: null,
        trace: null,
        batch: {
          regular: [
            { method: 'block', label: 'Get Block', defaultParams: '{"finality":"final"}' },
            { method: 'status', label: 'Node Status', defaultParams: '[]' },
            { method: 'gas_price', label: 'Gas Price', defaultParams: '[null]' },
            { method: 'validators', label: 'Validators', defaultParams: '[null]' },
          ],
          archive: [
            {
              method: 'query',
              label: 'Query (Archive)',
              defaultParams:
                '{"request_type":"view_account","account_id":"example.testnet","block_id":10000000}',
            },
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
        regular: [
          { method: 'getBlockHeight', label: 'Block Height', params: '[]' },
          { method: 'getSlot', label: 'Current Slot', params: '[]' },
          { method: 'getEpochInfo', label: 'Epoch Info', params: '[]' },
          { method: 'getHealth', label: 'Health', params: '[]' },
          { method: 'getVersion', label: 'Version', params: '[]' },
        ],
        archive: null,
        debug: null,
        trace: [
          {
            method: 'getTransaction',
            label: 'Get Transaction',
            params: '["5FtxSignatureHere", {"maxSupportedTransactionVersion":0}]',
          },
        ],
        batch: {
          regular: [
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
        regular: [
          { method: 'status', label: 'Status', params: '[]' },
          { method: 'health', label: 'Health', params: '[]' },
          { method: 'net_info', label: 'Net Info', params: '[]' },
        ],
        archive: [{ method: 'block', label: 'Block (Archive)', params: '{"height":"340801"}' }],
        debug: null,
        trace: null,
      },
      rest: {
        regular: [
          {
            method: 'GET',
            label: 'Latest Block',
            params: '/cosmos/base/tendermint/v1beta1/blocks/latest',
          },
          {
            method: 'GET',
            label: 'Node Info',
            params: '/cosmos/base/tendermint/v1beta1/node_info',
          },
        ],
        archive: [
          {
            method: 'GET',
            label: 'Block (Archive)',
            params: '/cosmos/base/tendermint/v1beta1/blocks/340801',
          },
        ],
        debug: null,
        trace: null,
      },
      grpc: {
        regular: [
          {
            method: '/cosmos.base.tendermint.v1beta1.Service/GetLatestBlock',
            label: 'Get Latest Block',
            params: '{}',
          },
        ],
        archive: [
          {
            method: '/cosmos.base.tendermint.v1beta1.Service/GetBlockByHeight',
            label: 'Get Block By Height',
            params: '{"height":"340801"}',
          },
        ],
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
        regular: [
          { method: 'starknet_blockNumber', label: 'Block Number', params: '[]' },
          { method: 'starknet_chainId', label: 'Chain ID', params: '[]' },
          { method: 'starknet_syncing', label: 'Syncing Status', params: '[]' },
          { method: 'starknet_blockHashAndNumber', label: 'Block Hash & Number', params: '[]' },
        ],
        archive: [
          {
            method: 'starknet_getStorageAt',
            label: 'Get Storage At',
            params: '{"contract_address":"0x0123","key":"0x0","block_id":{"block_number":123456}}',
          },
        ],
        debug: null,
        trace: [
          {
            method: 'starknet_traceTransaction',
            label: 'Trace Transaction',
            params: '{"transaction_hash":"0xTXHASH"}',
          },
        ],
        batch: {
          regular: [
            { method: 'starknet_blockNumber', label: 'Block Number', defaultParams: '[]' },
            { method: 'starknet_chainId', label: 'Chain ID', defaultParams: '[]' },
            { method: 'starknet_syncing', label: 'Syncing Status', defaultParams: '[]' },
            {
              method: 'starknet_blockHashAndNumber',
              label: 'Block Hash & Number',
              defaultParams: '[]',
            },
          ],
          archive: [
            {
              method: 'starknet_getStorageAt',
              label: 'Get Storage At (Archive)',
              defaultParams:
                '{"contract_address":"0x0123","key":"0x0","block_id":{"block_number":123456}}',
            },
          ],
          trace: [
            {
              method: 'starknet_traceTransaction',
              label: 'Trace Transaction',
              defaultParams: '{"transaction_hash":"0xTXHASH"}',
            },
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
        regular: [
          { method: 'GET', label: 'Node Info', params: '/wallet/getnodeinfo' },
          { method: 'GET', label: 'Get Now Block', params: '/wallet/getnowblock' },
        ],
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
        regular: [
          { method: 'GET', label: 'Wallet Information', params: '/api/v2/getWalletInformation' },
          { method: 'GET', label: 'Address Information', params: '/api/v2/getAddressInformation' },
        ],
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
        regular: [
          { method: 'getVersionInfo', label: 'Version Info', params: '[]' },
          { method: 'getHealth', label: 'Health', params: '[]' },
          { method: 'getNetwork', label: 'Network', params: '[]' },
        ],
        archive: null,
        debug: null,
        trace: null,
        batch: {
          regular: [
            { method: 'getVersionInfo', label: 'Version Info', defaultParams: '[]' },
            { method: 'getHealth', label: 'Health', defaultParams: '[]' },
            { method: 'getNetwork', label: 'Network', defaultParams: '[]' },
          ],
        },
      },
      rest: {
        regular: [
          {
            method: 'GET',
            label: 'Get Transaction',
            params:
              '/transactions/2a51b7475e3596cf4ece98c2b017eeab6b292d7d14c861d060cd3b1e164b5608',
          },
        ],
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
        regular: [{ method: 'server_info', label: 'Server Info', params: '[]' }],
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
        regular: [
          { method: 'GET', label: 'Root', params: '/' },
          { method: 'GET', label: 'Ledger Info', params: '/v1' },
        ],
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
        regular: [
          { method: 'getblockcount', label: 'Block Count', params: '[]' },
          { method: 'getbestblockhash', label: 'Best Block Hash', params: '[]' },
          { method: 'getblockchaininfo', label: 'Blockchain Info', params: '[]' },
          { method: 'getnetworkinfo', label: 'Network Info', params: '[]' },
        ],
        archive: [{ method: 'getblockhash', label: 'Get Block Hash', params: '[800000]' }],
        debug: null,
        trace: null,
        batch: {
          regular: [
            { method: 'getblockcount', label: 'Block Count', defaultParams: '[]' },
            { method: 'getbestblockhash', label: 'Best Block Hash', defaultParams: '[]' },
            { method: 'getblockchaininfo', label: 'Blockchain Info', defaultParams: '[]' },
            { method: 'getnetworkinfo', label: 'Network Info', defaultParams: '[]' },
            { method: 'getmempoolinfo', label: 'Mempool Info', defaultParams: '[]' },
          ],
          archive: [
            {
              method: 'getblockhash',
              label: 'Get Block Hash (Archive)',
              defaultParams: '[800000]',
            },
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
        regular: [
          {
            method: 'getAccountInfo',
            label: 'Account Info',
            params: '{"account":{"accountId":"0.0.1"}}',
          },
          { method: 'getLedgerId', label: 'Ledger ID', params: '[]' },
        ],
        archive: [
          {
            method: 'getAccountInfo',
            label: 'Account Info (Archive)',
            params: '{"account":{"accountId":"0.0.1"},"blockNumber":"latest"}',
          },
        ],
        debug: null,
        trace: null,
        batch: {
          regular: [
            {
              method: 'getAccountInfo',
              label: 'Account Info',
              defaultParams: '{"account":{"accountId":"0.0.1"}}',
            },
            { method: 'getLedgerId', label: 'Ledger ID', defaultParams: '[]' },
          ],
          archive: [
            {
              method: 'getAccountInfo',
              label: 'Account Info (Archive)',
              defaultParams: '{"account":{"accountId":"0.0.1"},"blockNumber":"latest"}',
            },
          ],
        },
      },
      rest: {
        regular: [{ method: 'GET', label: 'Account Info', params: '/api/v1/accounts/0.0.1' }],
        archive: [
          {
            method: 'GET',
            label: 'Account Info (Archive)',
            params: '/api/v1/accounts/0.0.1?block=latest',
          },
        ],
        debug: null,
        trace: null,
      },
    },
  },
];

// Helper function to build a JSON-RPC request from an AddonCommand
export function buildJsonRpcRequest(command: AddonCommand, id: number = 1): string {
  const params = JSON.parse(command.params);
  return JSON.stringify({
    jsonrpc: '2.0',
    method: command.method,
    params,
    id,
  });
}

// Helper function to build a REST request from an AddonCommand
export function buildRestRequest(command: AddonCommand): { method: string; path: string } {
  return {
    method: command.method,
    path: command.params,
  };
}
