export type ChainType = {
  value: string;
  label: string;
  interfaces: {
    [interfaceName: string]: {
      regular: string | null;
      archive: string | null;
      debug: string | null;
      trace: string | null;
    };
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
          '{"jsonrpc":"2.0","method":"debug_traceTransaction","params":["0x845f3b66c19395916a00f379fb783afbf0f38e4252fbb1c04ea37e356885f2b7",{}],"id":1}',
        trace:
          '{"jsonrpc":"2.0","method":"trace_transaction","params":["0x845f3b66c19395916a00f379fb783afbf0f38e4252fbb1c04ea37e356885f2b7"],"id":1}',
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
];
